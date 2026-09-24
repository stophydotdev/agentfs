import type { z } from "zod";

import { BlobError, errorFromResponse } from "./errors";
import { defaultRetryPolicy, ExpiredUrlError, withRetry, type RetryPolicy } from "./retry";
import { fileSchema, partUrlsSchema, uploadSessionSchema, type StoredFile, type UploadSession } from "./schemas";

const PART_URL_BATCH = 100;
const COMPLETE_POLLS = 30;

export interface ClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly retry?: Partial<RetryPolicy>;
  readonly concurrency?: number;
}

export interface WriteOptions {
  readonly replace?: boolean;
  readonly contentType?: string;
  readonly cache?: string;
  readonly metadata?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (uploaded: number, total: number) => void;
}

type Init = RequestInit & { readonly headers?: Record<string, string> };

export const encodePath = (path: string): string => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

export const createClient = (options: ClientOptions) => {
  const baseUrl = (options.baseUrl ?? "https://agentfs.cloud").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const policy: RetryPolicy = { ...defaultRetryPolicy, ...options.retry };
  const concurrency = Math.max(1, options.concurrency ?? 6);

  const send = async (path: string, init: Init = {}): Promise<Response> => {
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${options.token}`, ...init.headers } });
    if (!response.ok) throw await errorFromResponse(response, `${init.method ?? "GET"} ${path} failed with ${response.status}.`);
    return response;
  };

  const json = async <Schema extends z.ZodType>(schema: Schema, path: string, init?: Init): Promise<z.infer<Schema>> =>
    schema.parse(await (await send(path, init)).json());

  const jsonInit = (method: string, body: object, signal?: AbortSignal): Init => ({
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    ...(signal ? { signal } : {}),
  });

  const putFile = async (path: string, blob: Blob, write: WriteOptions & { readonly ifNoneMatch?: boolean; readonly ifMatch?: string }): Promise<StoredFile> => {
    const query = new URLSearchParams();
    if (write.cache) query.set("cache", write.cache);
    if (write.metadata) query.set("metadata", JSON.stringify(write.metadata));
    const headers: Record<string, string> = {};
    const type = write.contentType ?? blob.type;
    if (type) headers["content-type"] = type;
    if (write.ifNoneMatch) headers["if-none-match"] = "*";
    if (write.ifMatch !== undefined) headers["if-match"] = write.ifMatch;
    const stored = await withRetry(
      () => json(fileSchema, `/v1/files/${encodePath(path)}${query.size ? `?${query}` : ""}`, { method: "PUT", body: blob, headers, ...(write.signal ? { signal: write.signal } : {}) }),
      policy,
      write.signal,
    );
    write.onProgress?.(blob.size, blob.size);
    return stored;
  };

  const putBytes = async (url: string, bytes: Blob, label: string, signal: AbortSignal | undefined, withAuth: boolean): Promise<void> => {
    const headers: Record<string, string> = withAuth ? { authorization: `Bearer ${options.token}` } : {};
    const response = await fetchImpl(url, { method: "PUT", body: bytes, headers, ...(signal ? { signal } : {}) });
    if (response.ok) return;
    if (!withAuth && (response.status === 401 || response.status === 403)) throw new ExpiredUrlError(`Storage rejected ${label} with ${response.status}.`);
    throw await errorFromResponse(response, `Storage rejected ${label} with ${response.status}.`);
  };

  const sendParts = async (session: UploadSession, blob: Blob, write: WriteOptions): Promise<void> => {
    const size = blob.size;
    const sizeOf = (part: number) => Math.min(part * session.part_size, size) - (part - 1) * session.part_size;
    const done = new Set(session.uploaded_parts.map((part) => part.part_number));
    let uploaded = [...done].reduce((sum, part) => sum + sizeOf(part), 0);
    write.onProgress?.(uploaded, size);
    const pending = Array.from({ length: session.total_parts }, (_, index) => index + 1).filter((part) => !done.has(part));
    const batches = new Map<number, Promise<Map<number, string>>>();
    const partUrl = async (part: number, fresh: boolean): Promise<string> => {
      const index = Math.floor((part - 1) / PART_URL_BATCH);
      if (fresh) batches.delete(index);
      let batch = batches.get(index);
      if (!batch) {
        const from = index * PART_URL_BATCH + 1;
        const to = Math.min(from + PART_URL_BATCH - 1, session.total_parts);
        batch = withRetry(() => json(partUrlsSchema, `/v1/uploads/${session.id}/part-urls?from=${from}&to=${to}`), policy, write.signal)
          .then(({ parts }) => new Map(parts.map((entry) => [entry.part_number, entry.url])));
        batches.set(index, batch);
        batch.catch(() => batches.delete(index));
      }
      const url = (await batch).get(part);
      if (!url) throw new BlobError("request_failed", { message: `The server sent no URL for part ${part}.`, status: 502, retryable: true });
      return url;
    };
    const sendPart = async (part: number) => {
      const bytes = blob.slice((part - 1) * session.part_size, (part - 1) * session.part_size + sizeOf(part));
      let fresh = false;
      await withRetry(async () => {
        try {
          if (session.transport === "worker") await putBytes(`${baseUrl}/v1/uploads/${session.id}/parts/${part}`, bytes, `part ${part}`, write.signal, true);
          else await putBytes(await partUrl(part, fresh), bytes, `part ${part}`, write.signal, false);
        } catch (error) {
          fresh = error instanceof ExpiredUrlError;
          throw error;
        }
      }, policy, write.signal);
      uploaded += sizeOf(part);
      write.onProgress?.(uploaded, size);
    };
    let next = 0;
    const worker = async () => {
      for (let part = pending[next++]; part !== undefined; part = pending[next++]) await sendPart(part);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  };

  const sendWhole = async (session: UploadSession, blob: Blob, write: WriteOptions): Promise<void> => {
    let url = session.upload_url;
    await withRetry(async () => {
      if (!url) url = (await json(uploadSessionSchema, `/v1/uploads/${session.id}`)).upload_url;
      if (!url) throw new BlobError("request_failed", { message: `Upload ${session.id} has no upload URL.`, status: 409 });
      try {
        await putBytes(url, blob, "the file", write.signal, false);
      } catch (error) {
        if (error instanceof ExpiredUrlError) url = undefined;
        throw error;
      }
    }, policy, write.signal);
    write.onProgress?.(blob.size, blob.size);
  };

  const complete = async (id: string, signal: AbortSignal | undefined): Promise<StoredFile> => {
    for (let attempt = 0; attempt < COMPLETE_POLLS; attempt += 1) {
      const response = await withRetry(() => send(`/v1/uploads/${id}/complete`, { method: "POST", ...(signal ? { signal } : {}) }), policy, signal);
      if (response.status === 200) return fileSchema.parse(await response.json());
      await policy.sleep(1000);
    }
    throw new BlobError("not_ready", { message: `Upload ${id} is still finishing. Check it later with info().`, status: 504, retryable: true });
  };

  const uploadInParts = async (path: string, blob: Blob, write: WriteOptions): Promise<StoredFile> => {
    const created = await withRetry(() => json(uploadSessionSchema, "/v1/uploads", jsonInit("POST", {
      path: encodePath(path),
      size_bytes: blob.size,
      multipart: true,
      ...(write.replace ? { if_exists: "replace" } : {}),
      content_type: write.contentType ?? (blob.type || undefined),
      cache: write.cache,
      metadata: write.metadata,
    }, write.signal)), policy, write.signal);
    try {
      if (created.upload_url) await sendWhole(created, blob, write);
      else await sendParts(created, blob, write);
    } catch (error) {
      if (!(error instanceof BlobError) || !error.retryable) await send(`/v1/uploads/${created.id}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    }
    return complete(created.id, write.signal);
  };

  return { send, json, jsonInit, putFile, uploadInParts, complete, policy };
};

export type Client = ReturnType<typeof createClient>;
