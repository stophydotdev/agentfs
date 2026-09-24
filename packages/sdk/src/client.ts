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

export type Source = Blob | { readonly stream: ReadableStream<Uint8Array>; readonly size: number };

export interface WriteOptions {
  readonly contentType: string;
  readonly cache?: string;
  readonly metadata?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (uploaded: number, total: number) => void;
}

export interface PutConditions {
  readonly ifNoneMatch?: boolean;
  readonly ifMatch?: string;
}

export interface SessionOptions {
  readonly multipart: boolean;
  readonly ifExists: "error" | "replace";
  readonly ifMatch?: string;
}

type Init = RequestInit & { readonly headers?: Record<string, string>; readonly idempotent?: boolean };

const RETRIED_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
type Bytes = Blob | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

export const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export const checkPath = (path: string): string => {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("path must be a non-empty string");
  if (path.split("/").some((segment) => segment === "." || segment === "..")) throw new TypeError(`path may not contain "." or ".." segments: ${path}`);
  return path;
};

const bodyInit = (body: Bytes): RequestInit => {
  if (!(body instanceof ReadableStream)) return { body };
  const init = { body, duplex: "half" };
  return init;
};

const chunker = (stream: ReadableStream<Uint8Array>, declared: number) => {
  const reader = stream.getReader();
  let leftover: Uint8Array = new Uint8Array(0);
  let read = 0;
  const longer = () => new BlobError("invalid_input", { message: `body is longer than the declared ${declared} bytes` });
  return {
    take: async (length: number): Promise<Uint8Array<ArrayBuffer>> => {
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        if (leftover.byteLength === 0) {
          const { done, value } = await reader.read();
          if (done) throw new BlobError("invalid_input", { message: `body was ${read + filled} bytes, ${declared} were declared` });
          leftover = value;
          continue;
        }
        const take = Math.min(leftover.byteLength, length - filled);
        out.set(leftover.subarray(0, take), filled);
        filled += take;
        leftover = leftover.subarray(take);
      }
      read += length;
      return out;
    },
    finish: async (): Promise<void> => {
      if (leftover.byteLength) throw longer();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.byteLength) throw longer();
      }
    },
    cancel: (reason: unknown) => reader.cancel(reason).catch(() => undefined),
  };
};

export const createClient = (options: ClientOptions) => {
  const baseUrl = (options.baseUrl ?? "https://agentfs.cloud").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const policy: RetryPolicy = { ...defaultRetryPolicy, ...options.retry };
  const concurrency = Math.max(1, options.concurrency ?? 6);

  const send = async (path: string, { idempotent, ...init }: Init = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const attempt = async () => {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${options.token}`, ...init.headers } });
      if (!response.ok) throw await errorFromResponse(response, `${method} ${path} failed with ${response.status}.`);
      return response;
    };
    const retried = !(init.body instanceof ReadableStream) && (idempotent ?? RETRIED_METHODS.has(method.toUpperCase()));
    return retried ? withRetry(attempt, policy, init.signal) : attempt();
  };

  const json = async <Schema extends z.ZodType>(schema: Schema, path: string, init?: Init): Promise<z.infer<Schema>> =>
    schema.parse(await (await send(path, init)).json());

  const jsonInit = (method: string, body: object, signal?: AbortSignal): Init => ({
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    ...(signal ? { signal } : {}),
  });

  const retryUnlessStream = <T>(source: Source, task: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> =>
    source instanceof Blob ? withRetry(task, policy, signal) : task();

  const bytesOf = (source: Source): Blob | ReadableStream<Uint8Array> => (source instanceof Blob ? source : source.stream);

  const putFile = async (path: string, source: Source, write: WriteOptions & PutConditions): Promise<StoredFile> => {
    const query = new URLSearchParams({ infer_content_type: "false" });
    if (write.cache) query.set("cache", write.cache);
    if (write.metadata) query.set("metadata", JSON.stringify(write.metadata));
    const headers: Record<string, string> = { "content-type": write.contentType, "content-length": String(source.size) };
    if (write.ifNoneMatch) headers["if-none-match"] = "*";
    if (write.ifMatch !== undefined) headers["if-match"] = write.ifMatch;
    const stored = await json(fileSchema, `/v1/files/${encodePath(path)}?${query}`, { method: "PUT", ...bodyInit(bytesOf(source)), headers, ...(write.signal ? { signal: write.signal } : {}) });
    write.onProgress?.(source.size, source.size);
    return stored;
  };

  const putBytes = async (url: string, bytes: Bytes, length: number, label: string, signal: AbortSignal | undefined, withAuth: boolean): Promise<void> => {
    const headers: Record<string, string> = withAuth ? { authorization: `Bearer ${options.token}` } : {};
    if (bytes instanceof ReadableStream) headers["content-length"] = String(length);
    const response = await fetchImpl(url, { method: "PUT", ...bodyInit(bytes), headers, ...(signal ? { signal } : {}) });
    if (response.ok) return;
    if (!withAuth && (response.status === 401 || response.status === 403)) throw new ExpiredUrlError(`Storage rejected ${label} with ${response.status}.`);
    throw await errorFromResponse(response, `Storage rejected ${label} with ${response.status}.`);
  };

  const sendParts = async (session: UploadSession, source: Source, write: WriteOptions): Promise<void> => {
    const size = source.size;
    const sizeOf = (part: number) => Math.min(part * session.part_size, size) - (part - 1) * session.part_size;
    const done = new Set(session.uploaded_parts.map((part) => part.part_number));
    let uploaded = [...done].reduce((sum, part) => sum + sizeOf(part), 0);
    write.onProgress?.(uploaded, size);
    const batches = new Map<number, Promise<Map<number, string>>>();
    const partUrl = async (part: number, fresh: boolean): Promise<string> => {
      const index = Math.floor((part - 1) / PART_URL_BATCH);
      if (fresh) batches.delete(index);
      let batch = batches.get(index);
      if (!batch) {
        const from = index * PART_URL_BATCH + 1;
        const to = Math.min(from + PART_URL_BATCH - 1, session.total_parts);
        batch = json(partUrlsSchema, `/v1/uploads/${session.id}/part-urls?from=${from}&to=${to}`, write.signal ? { signal: write.signal } : {})
          .then(({ parts }) => new Map(parts.map((entry) => [entry.part_number, entry.url])));
        batches.set(index, batch);
        batch.catch(() => batches.delete(index));
      }
      const url = (await batch).get(part);
      if (!url) throw new BlobError("request_failed", { message: `The server sent no URL for part ${part}.`, status: 502, retryable: true });
      return url;
    };
    const sendPart = async (part: number, bytes: Blob | Uint8Array<ArrayBuffer>) => {
      let fresh = false;
      await withRetry(async () => {
        try {
          if (session.transport === "worker") await putBytes(`${baseUrl}/v1/uploads/${session.id}/parts/${part}`, bytes, sizeOf(part), `part ${part}`, write.signal, true);
          else await putBytes(await partUrl(part, fresh), bytes, sizeOf(part), `part ${part}`, write.signal, false);
        } catch (error) {
          fresh = error instanceof ExpiredUrlError;
          throw error;
        }
      }, policy, write.signal);
      uploaded += sizeOf(part);
      write.onProgress?.(uploaded, size);
    };
    const parts = Array.from({ length: session.total_parts }, (_, index) => index + 1);
    if (!(source instanceof Blob)) {
      const chunks = chunker(source.stream, size);
      try {
        for (const part of parts) {
          const bytes = await chunks.take(sizeOf(part));
          if (!done.has(part)) await sendPart(part, bytes);
        }
        await chunks.finish();
      } catch (error) {
        await chunks.cancel(error);
        throw error;
      }
      return;
    }
    const pending = parts.filter((part) => !done.has(part));
    let next = 0;
    const worker = async () => {
      for (let part = pending[next++]; part !== undefined; part = pending[next++]) {
        const start = (part - 1) * session.part_size;
        await sendPart(part, source.slice(start, start + sizeOf(part)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  };

  const sendWhole = async (session: UploadSession, source: Source, write: WriteOptions): Promise<void> => {
    let url = session.upload_url;
    await retryUnlessStream(source, async () => {
      if (!url) url = (await json(uploadSessionSchema, `/v1/uploads/${session.id}`)).upload_url;
      if (!url) throw new BlobError("request_failed", { message: `Upload ${session.id} has no upload URL.`, status: 409 });
      try {
        await putBytes(url, bytesOf(source), source.size, "the file", write.signal, false);
      } catch (error) {
        if (error instanceof ExpiredUrlError) url = undefined;
        throw error;
      }
    }, write.signal);
    write.onProgress?.(source.size, source.size);
  };

  const complete = async (id: string, signal: AbortSignal | undefined): Promise<StoredFile> => {
    for (let attempt = 0; attempt < COMPLETE_POLLS; attempt += 1) {
      const response = await withRetry(() => send(`/v1/uploads/${id}/complete`, { method: "POST", ...(signal ? { signal } : {}) }), policy, signal);
      if (response.status === 200) return fileSchema.parse(await response.json());
      await policy.sleep(1000);
    }
    throw new BlobError("not_ready", { message: `Upload ${id} is still finishing. Check it later with info().`, status: 504, retryable: true });
  };

  const upload = async (path: string, source: Source, write: WriteOptions & SessionOptions): Promise<StoredFile> => {
    const created = await withRetry(() => json(uploadSessionSchema, "/v1/uploads", jsonInit("POST", {
      path: encodePath(path),
      size_bytes: source.size,
      multipart: write.multipart,
      if_exists: write.ifExists,
      ...(write.ifMatch === undefined ? {} : { if_match: write.ifMatch }),
      content_type: write.contentType,
      infer_content_type: false,
      cache: write.cache,
      metadata: write.metadata,
    }, write.signal)), policy, write.signal);
    try {
      if (created.upload_url) await sendWhole(created, source, write);
      else await sendParts(created, source, write);
    } catch (error) {
      if (!(source instanceof Blob)) await source.stream.cancel(error).catch(() => undefined);
      if (!(error instanceof BlobError) || !error.retryable || !(source instanceof Blob)) await send(`/v1/uploads/${created.id}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    }
    return complete(created.id, write.signal);
  };

  return { send, json, jsonInit, putFile, upload, complete, policy };
};

export type Client = ReturnType<typeof createClient>;
