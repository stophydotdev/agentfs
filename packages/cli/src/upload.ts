import { openAsBlob, statSync } from "node:fs";
import { basename } from "node:path";

import { ApiError, type Client, type StoredFile } from "./api";

export const ONE_SHOT_LIMIT = 100 * 1024 * 1024;
const PART_URL_BATCH = 100;
const COMPLETE_POLLS = 30;
const PART_ATTEMPTS = 3;

class StorageError extends Error {
  constructor(readonly status: number) {
    super(`Storage rejected a part (HTTP ${status}).`);
  }
}

const retryable = (error: unknown) => {
  const status = error instanceof ApiError ? error.status : error instanceof StorageError ? error.status : undefined;
  return status === undefined || status >= 500 || status === 429 || status === 408;
};

export async function withRetry<T>(task: () => Promise<T>, attempts = PART_ATTEMPTS, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      await wait(1000 * 2 ** (attempt - 1));
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

async function targetPath(client: Client, local: string, options: UploadOptions) {
  const project = await projectOf(client, options.project);
  return options.path ? joinPath(project, options.path) : joinPath(project, options.prefix, basename(local));
}

async function putBytes(url: string, bytes: Blob) {
  const response = await fetch(url, { method: "PUT", body: bytes });
  await response.body?.cancel();
  if (!response.ok) throw new StorageError(response.status);
}

async function uploadSession(client: Client, local: string, size: number, options: UploadOptions, onProgress?: (done: number) => void) {
  const blob = await openAsBlob(local);
  const session = await client.createUpload({
    path: await targetPath(client, local, options),
    size_bytes: size,
    visibility: options.visibility,
    expires_in: options.expiresIn,
    label: options.label,
  });
  const slice = (part: number) => blob.slice((part - 1) * session.part_size, Math.min(part * session.part_size, size));
  try {
    await transfer();
  } catch (error) {
    await client.abortUpload(session.id);
    throw error;
  }
  for (let attempt = 0; attempt < COMPLETE_POLLS; attempt += 1) {
    const done = await client.completeUpload(session.id);
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Upload ${session.id} is still finishing. Check it later with agentfs ls.`);

  async function transfer() {
    if (session.transport === "s3" && session.upload_url) {
      const url = session.upload_url;
      await withRetry(() => putBytes(url, blob));
      onProgress?.(size);
    } else if (session.transport === "s3") {
      for (let from = 1; from <= session.total_parts; from += PART_URL_BATCH) {
        const { parts } = await client.partUrls(session.id, from, Math.min(from + PART_URL_BATCH - 1, session.total_parts));
        for (const part of parts) {
          await withRetry(() => putBytes(part.url, slice(part.part_number)));
          onProgress?.(Math.min(part.part_number * session.part_size, size));
        }
      }
    } else {
      for (let part = 1; part <= session.total_parts; part += 1) {
        await withRetry(() => client.putPart(session.id, part, slice(part)));
        onProgress?.(Math.min(part * session.part_size, size));
      }
    }
  }
}

export async function uploadFile(
  client: Client,
  local: string,
  options: UploadOptions,
  onProgress?: (done: number) => void,
  oneShotLimit = ONE_SHOT_LIMIT,
): Promise<StoredFile> {
  const stats = statSync(local);
  if (!stats.isFile()) throw new Error(`${local} is not a file.`);
  if (stats.size <= oneShotLimit) return uploadOneShot(client, local, options);
  return uploadSession(client, local, stats.size, options, onProgress);
}
