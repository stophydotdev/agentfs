import { openAsBlob } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Api, ApiError, type Part, type Wanted, type Write, configDir, putToUrl } from "./api";
import { inParallel } from "./local";

const ATTEMPTS = 3;
const URL_LIFETIME_MS = 5 * 60 * 60 * 1000;

const saved = z.object({
  upload: z.string(),
  uploadId: z.string(),
  partBytes: z.number(),
  direct: z.literal(true),
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

const partUrls = (api: Api, { upload, uploadId }: Progress) => {
  const known = new Map<number, { url: string; at: number }>();
  let queue: Promise<unknown> = Promise.resolve();
  const get = (partNumber: number, failed?: string) => {
    const next = queue.then(async () => {
      const current = known.get(partNumber);
      if (current === undefined || current.url === failed || Date.now() - current.at > URL_LIFETIME_MS) {
        const page = await api.partUrls(upload, uploadId, partNumber);
        page.partUrls.forEach((url, index) => known.set(page.from + index, { url, at: Date.now() }));
      }
      const url = known.get(partNumber)?.url;
      if (url === undefined) throw new Error(`the server sent no URL for part ${partNumber}`);
      return url;
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const seed = (urls: string[]) => urls.forEach((url, index) => known.set(index + 1, { url, at: Date.now() }));
  return { get, seed };
};

const sendPart = async (urls: ReturnType<typeof partUrls>, partNumber: number, body: Blob) => {
  const first = await urls.get(partNumber);
  const sent = await putToUrl(first, body);
  if (sent.kind === "ok") return sent.etag;
  const retried = await putToUrl(await urls.get(partNumber, first), body);
  if (retried.kind === "ok") return retried.etag;
  throw new Error(`storage refused part ${partNumber} with a fresh URL`);
};

const begin = async (api: Api, local: Wanted, write: Write) => {
  const { upload, uploadId, partBytes, partUrls: first } = await api.startUpload(local, write.ttlSeconds);
  const progress: Progress = { upload, uploadId, partBytes, direct: true, done: [] };
  return { progress, first };
};

const sendParts = async (api: Api, local: Wanted & { file: string }, write: Write) => {
  const existing = await resumed(api, local.sha256);
  const { progress, first } = existing === undefined ? await begin(api, local, write) : { progress: existing, first: [] };
  const urls = partUrls(api, progress);
  urls.seed(first);
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
    const etag = await withRetries(() => sendPart(urls, partNumber, body));
    const part: Part = { partNumber, etag };
    progress.done.push(part);
    await remember(api, local.sha256, progress);
  });
  const parts = progress.done.toSorted((a, b) => a.partNumber - b.partNumber);
  return api.completeUpload(progress.upload, progress.uploadId, local, parts, write.precondition);
};

export const uploadInParts = async (api: Api, local: Wanted & { file: string }, write: Write) => {
  const file = await sendParts(api, local, write).catch(async (error: Error) => {
    if (!(error instanceof ApiError && error.code === "upload_failed")) throw error;
    await rm(stateFile(api, local.sha256), { force: true });
    return sendParts(api, local, write);
  });
  await rm(stateFile(api, local.sha256), { force: true });
  return file;
};
