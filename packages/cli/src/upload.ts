import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, openAsBlob, readFileSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import { ApiError, problemError, type Client, type StoredFile, type UploadSession } from "./api";

const MIB = 1024 * 1024;
export const ONE_SHOT_LIMIT = 100 * MIB;
export const KEYLESS_TOO_LARGE = "Log in to upload files over 100 MB: agentfs login";
const PART_URL_BATCH = 100;
const COMPLETE_POLLS = 30;
const HTTP_ATTEMPTS = 8;
const DROP_ATTEMPTS = 20;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;

export type Transfer = {
  sessionThreshold: number;
  keylessLimit: number;
  concurrency: number;
  stallMs: number;
  stateDir: string;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export const defaultTransfer = (): Transfer => ({
  sessionThreshold: 16 * MIB,
  keylessLimit: ONE_SHOT_LIMIT,
  concurrency: 6,
  stallMs: 60_000,
  stateDir: join(homedir(), ".agentfs", "uploads"),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  random: Math.random,
});

class DroppedError extends Error {}
class ExpiredUrlError extends Error {}

const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

export async function withRetry<T>(task: () => Promise<T>, { sleep, random }: Pick<Transfer, "sleep" | "random">) {
  let failed = 0;
  let dropped = 0;
  for (;;) {
    try {
      return await task();
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      if (error instanceof ApiError && !retryableStatus(error.status)) throw error;
      const isHttp = error instanceof ApiError || error instanceof ExpiredUrlError;
      if (isHttp) failed += 1;
      else dropped += 1;
      if (failed >= HTTP_ATTEMPTS || dropped >= DROP_ATTEMPTS) throw error;
      if (error instanceof ExpiredUrlError) continue;
      const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failed + dropped - 1));
      await sleep(error instanceof ApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : random() * ceiling);
    }
  }
}

export type UploadOptions = {
  project?: string;
  path?: string;
  prefix?: string;
  visibility?: string;
  expiresIn?: string;
  label?: string;
  replace?: boolean;
  runId?: string;
  agentId?: string;
};

export const joinPath = (...parts: (string | undefined)[]) =>
  parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");

function runHeaders(options: UploadOptions): Record<string, string> {
  return {
    ...(options.runId ? { "x-run-id": options.runId } : {}),
    ...(options.agentId ? { "x-agent-id": options.agentId } : {}),
  };
}

export async function projectOf(client: Client, project: string | undefined) {
  return project ?? (await client.me()).default_project ?? "default";
}

async function uploadOneShot(client: Client, local: string, options: UploadOptions) {
  const form = new FormData();
  form.append("file", await openAsBlob(local), basename(local));
  const fields: Record<string, string | undefined> = {
    path: await targetPath(client, local, options),
    visibility: options.visibility,
    expires_in: options.expiresIn,
    label: options.label,
    if_exists: options.replace ? "replace" : undefined,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value) form.append(name, value);
  }
  return client.uploadForm(form, runHeaders(options));
}

async function uploadKeyless(client: Client, local: string) {
  const form = new FormData();
  form.append("file", await openAsBlob(local), basename(local));
  return client.uploadForm(form, {});
}

async function targetPath(client: Client, local: string, options: UploadOptions) {
  const project = await projectOf(client, options.project);
  return options.path ? joinPath(project, options.path) : joinPath(project, options.prefix, basename(local));
}

type Target = { url: string; headers: Record<string, string> };
type PutResult = { status: number; body: string; retryAfter: string | undefined };

function put(target: Target, bytes: Blob, stallMs: number, onSent: (bytes: number) => void) {
  return new Promise<PutResult>((done, reject) => {
    const url = new URL(target.url);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = send(url, { method: "PUT", headers: { ...target.headers, "content-length": String(bytes.size) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        arm();
      });
      response.on("error", fail);
      response.on("end", () => {
        clearTimeout(timer);
        const retryAfter = response.headers["retry-after"];
        done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(), retryAfter });
      });
    });
    function fail(error: Error) {
      clearTimeout(timer);
      reject(new DroppedError(`The connection dropped: ${error.message}`));
    }
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(() => request.destroy(new Error(`no upload progress for ${stallMs / 1000}s`)), stallMs);
    }
    request.on("error", fail);
    arm();
    void (async () => {
      for await (const chunk of bytes.stream()) {
        if (request.destroyed) return;
        const more = request.write(chunk, (error) => {
          if (error) return;
          onSent(chunk.byteLength);
          arm();
        });
        if (!more) await once(request, "drain");
      }
      request.end();
    })().catch((error: Error) => request.destroy(error));
  });
}

function progressOf(onProgress: ((done: number) => void) | undefined, resumed: number) {
  let done = resumed;
  const sending = new Map<number, number>();
  const report = () => onProgress?.(done + [...sending.values()].reduce((sum, bytes) => sum + bytes, 0));
  return {
    sent(part: number, bytes: number) {
      sending.set(part, (sending.get(part) ?? 0) + bytes);
      report();
    },
    reset(part: number) {
      sending.delete(part);
      report();
    },
    finish(part: number, bytes: number) {
      sending.delete(part);
      done += bytes;
      report();
    },
  };
}

type Route = { targetFor: (part: number) => Promise<Target>; expire?: (part: number) => void };

function routeOf(client: Client, session: UploadSession, transfer: Transfer): Route {
  const retry = <T>(task: () => Promise<T>) => withRetry(task, transfer);
  if (session.upload_url) {
    let url = Promise.resolve(session.upload_url);
    return {
      targetFor: async () => ({ url: await url, headers: {} }),
      expire: () => {
        url = retry(() => client.getUpload(session.id)).then((fresh) => {
          if (!fresh.upload_url) throw new Error(`Upload ${session.id} has no upload URL.`);
          return fresh.upload_url;
        });
      },
    };
  }
  if (session.transport === "worker") return { targetFor: async (part) => client.partTarget(session.id, part) };
  const batches = new Map<number, Promise<Map<number, string>>>();
  const batchOf = (part: number) => Math.floor((part - 1) / PART_URL_BATCH);
  const fetchBatch = (index: number) => {
    const from = index * PART_URL_BATCH + 1;
    const batch = retry(() => client.partUrls(session.id, from, Math.min(from + PART_URL_BATCH - 1, session.total_parts))).then(
      ({ parts }) => new Map(parts.map((part) => [part.part_number, part.url])),
    );
    batches.set(index, batch);
    batch.catch(() => batches.delete(index));
    return batch;
  };
  const used = new Map<number, Promise<Map<number, string>>>();
  return {
    targetFor: async (part) => {
      const batch = batches.get(batchOf(part)) ?? fetchBatch(batchOf(part));
      used.set(part, batch);
      const url = (await batch).get(part);
      if (!url) throw new Error(`The server sent no URL for part ${part}.`);
      return { url, headers: {} };
    },
    expire: (part) => {
      if (batches.get(batchOf(part)) === used.get(part)) batches.delete(batchOf(part));
    },
  };
}

async function sendParts(session: UploadSession, blob: Blob, route: Route, transfer: Transfer, onProgress?: (done: number) => void) {
  const size = blob.size;
  const sizeOf = (part: number) => Math.min(part * session.part_size, size) - (part - 1) * session.part_size;
  const uploaded = new Set((session.uploaded_parts ?? []).map((part) => part.part_number));
  const pending = Array.from({ length: session.total_parts }, (_, index) => index + 1).filter((part) => !uploaded.has(part));
  const progress = progressOf(onProgress, [...uploaded].reduce((sum, part) => sum + sizeOf(part), 0));

  const sendPart = async (part: number) => {
    progress.reset(part);
    const target = await route.targetFor(part);
    const bytes = blob.slice((part - 1) * session.part_size, (part - 1) * session.part_size + sizeOf(part));
    const result = await put(target, bytes, transfer.stallMs, (sent) => progress.sent(part, sent)).catch((error: unknown) => {
      progress.reset(part);
      throw error;
    });
    if (result.status >= 200 && result.status < 300) return progress.finish(part, sizeOf(part));
    progress.reset(part);
    if (route.expire && (result.status === 401 || result.status === 403)) {
      route.expire(part);
      throw new ExpiredUrlError(`Storage rejected part ${part} (HTTP ${result.status}).`);
    }
    throw problemError(result.status, result.body, result.retryAfter, `Storage rejected part ${part} (HTTP ${result.status}).`);
  };

  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    for (let part = pending[next++]; part !== undefined && !failure; part = pending[next++]) {
      await withRetry(() => sendPart(part), transfer).catch((error: unknown) => {
        failure ??= { error };
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(transfer.concurrency, pending.length) }, worker));
  if (failure) throw failure.error;
}

const stateSchema = z.object({ uploadId: z.string(), path: z.string(), size: z.number(), mtimeMs: z.number(), target: z.string() });

function resumeState(dir: string, local: string, stats: Stats, target: string) {
  const path = resolve(local);
  const key = createHash("sha256").update(`${path}\n${stats.size}\n${stats.mtimeMs}`).digest("hex");
  const file = join(dir, `${key}.json`);
  return {
    read() {
      try {
        const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        return parsed.success && parsed.data.target === target ? parsed.data.uploadId : undefined;
      } catch {
        return undefined;
      }
    },
    save(uploadId: string) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({ uploadId, path, size: stats.size, mtimeMs: stats.mtimeMs, target })}\n`, { mode: 0o600 });
    },
    clear() {
      rmSync(file, { force: true });
    },
  };
}

async function uploadSession(client: Client, local: string, stats: Stats, options: UploadOptions, transfer: Transfer, onProgress?: (done: number) => void) {
  const retry = <T>(task: () => Promise<T>) => withRetry(task, transfer);
  const blob = await openAsBlob(local);
  const path = await targetPath(client, local, options);
  const state = resumeState(transfer.stateDir, local, stats, path);
  const saved = state.read();
  const resumed = saved ? await retry(() => client.getUpload(saved)).catch(() => undefined) : undefined;
  if (resumed?.status === "completed" && resumed.file) {
    state.clear();
    return resumed.file;
  }
  const session =
    resumed && (resumed.status === "active" || resumed.status === "completing")
      ? resumed
      : await retry(() =>
          client.createUpload({
            path,
            size_bytes: stats.size,
            multipart: true,
            visibility: options.visibility,
            expires_in: options.expiresIn,
            label: options.label,
          }),
        );
  state.save(session.id);
  try {
    if (session.status !== "completing") await sendParts(session, blob, routeOf(client, session, transfer), transfer, onProgress);
  } catch (error) {
    if (error instanceof ApiError && !retryableStatus(error.status)) {
      await client.abortUpload(session.id);
      state.clear();
    }
    throw error;
  }
  for (let attempt = 0; attempt < COMPLETE_POLLS; attempt += 1) {
    const done = await retry(() => client.completeUpload(session.id));
    if (done) {
      state.clear();
      return done;
    }
    await transfer.sleep(1000);
  }
  throw new Error(`Upload ${session.id} is still finishing. Check it later with agentfs ls.`);
}

export async function uploadFile(
  client: Client,
  local: string,
  options: UploadOptions,
  onProgress?: (done: number) => void,
  overrides: Partial<Transfer> = {},
): Promise<StoredFile> {
  const transfer = { ...defaultTransfer(), ...overrides };
  const stats = statSync(local);
  if (!stats.isFile()) throw new Error(`${local} is not a file.`);
  if (!client.hasKey) {
    if (stats.size > transfer.keylessLimit) throw new Error(KEYLESS_TOO_LARGE);
    return uploadKeyless(client, local);
  }
  if (stats.size <= transfer.sessionThreshold) return uploadOneShot(client, local, options);
  return uploadSession(client, local, stats, options, transfer, onProgress);
}
