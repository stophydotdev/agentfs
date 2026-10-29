import { openAsBlob } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Api, ApiError, type Part, type Wanted, configDir } from "./api";
import { inParallel } from "./local";

const ATTEMPTS = 3;

const saved = z.object({
  upload: z.string(),
  uploadId: z.string(),
  partBytes: z.number(),
  done: z.array(z.object({ partNumber: z.number(), etag: z.string() })),
});

type Progress = z.infer<typeof saved>;

const stateFile = (api: Api, sha256: string) =>
  join(configDir, "uploads", `${api.account}-${sha256}.json`);

const resumed = async (api: Api, sha256: string) =>
  saved.safeParse(JSON.parse(await readFile(stateFile(api, sha256), "utf8").catch(() => "null"))).data;

const remember = async (api: Api, sha256: string, progress: Progress) => {
  await mkdir(join(configDir, "uploads"), { recursive: true });
  await writeFile(stateFile(api, sha256), JSON.stringify(progress));
};

const withRetries = async <Result>(work: () => Promise<Result>, attempt = 1): Promise<Result> =>
  work().catch((error: Error) => {
    if (attempt >= ATTEMPTS || (error instanceof ApiError && error.code === "upload_failed")) throw error;
    return withRetries(work, attempt + 1);
  });

const sendParts = async (api: Api, local: Wanted & { file: string }) => {
  const progress = (await resumed(api, local.sha256)) ?? {
    ...(await api.startUpload(local)),
    done: [],
  };
  await remember(api, local.sha256, progress);
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
      api.uploadPart(progress.upload, progress.uploadId, partNumber, body),
    );
    progress.done.push(part);
    await remember(api, local.sha256, progress);
  });
  const parts = progress.done.toSorted((a, b) => a.partNumber - b.partNumber);
  return api.completeUpload(progress.upload, progress.uploadId, local, parts);
};

export const uploadInParts = async (api: Api, local: Wanted & { file: string }) => {
  const file = await sendParts(api, local).catch(async (error: Error) => {
    if (!(error instanceof ApiError && error.code === "upload_failed")) throw error;
    await rm(stateFile(api, local.sha256), { force: true });
    return sendParts(api, local);
  });
  await rm(stateFile(api, local.sha256), { force: true });
  return file;
};
