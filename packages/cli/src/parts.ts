import { openAsBlob } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Api, type Part, type Wanted, configDir } from "./api";
import { inParallel } from "./local";

const ATTEMPTS = 3;

const saved = z.object({
  uploadId: z.string(),
  partBytes: z.number(),
  done: z.array(z.object({ partNumber: z.number(), etag: z.string() })),
});

type Progress = z.infer<typeof saved>;

const stateFile = (sha256: string) => join(configDir, "uploads", `${sha256}.json`);

const resumed = async (sha256: string) =>
  saved.safeParse(JSON.parse(await readFile(stateFile(sha256), "utf8").catch(() => "null"))).data;

const remember = async (sha256: string, progress: Progress) => {
  await mkdir(join(configDir, "uploads"), { recursive: true });
  await writeFile(stateFile(sha256), JSON.stringify(progress));
};

const withRetries = async <Result>(work: () => Promise<Result>, attempt = 1): Promise<Result> =>
  work().catch((error: Error) => {
    if (attempt >= ATTEMPTS) throw error;
    return withRetries(work, attempt + 1);
  });

export const uploadInParts = async (api: Api, local: Wanted & { file: string }) => {
  const progress = (await resumed(local.sha256)) ?? {
    ...(await api.startUpload({ path: local.path, sha256: local.sha256, size: local.size })),
    done: [],
  };
  await remember(local.sha256, progress);
  const blob = await openAsBlob(local.file);
  const count = Math.ceil(local.size / progress.partBytes);
  const finished = new Set(progress.done.map((done) => done.partNumber));
  const remaining = Array.from({ length: count }, (_, index) => index + 1).filter(
    (partNumber) => !finished.has(partNumber),
  );
  await inParallel(remaining, async (partNumber) => {
    const start = (partNumber - 1) * progress.partBytes;
    const body = blob.slice(start, start + progress.partBytes);
    const part: Part = await withRetries(() =>
      api.uploadPart(local.sha256, progress.uploadId, partNumber, body),
    );
    progress.done.push(part);
    await remember(local.sha256, progress);
  });
  const parts = progress.done.toSorted((a, b) => a.partNumber - b.partNumber);
  const file = await api.completeUpload(local.sha256, progress.uploadId, local.path, parts);
  await rm(stateFile(local.sha256), { force: true });
  return file;
};
