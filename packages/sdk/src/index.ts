import type { z } from "zod";

import { AgentFSError, errorFromResponse } from "./errors";
import { defaultRetryPolicy, ExpiredUrlError, withRetry, type RetryPolicy } from "./retry";
import {
  accessUrlSchema,
  accountSchema,
  fileListSchema,
  fileSchema,
  partUrlsSchema,
  revokeSchema,
  uploadSessionSchema,
  type AgentFile,
  type UploadSession,
  type Visibility,
} from "./schemas";

export { AgentFSError } from "./errors";
export type { RetryPolicy } from "./retry";
export type { Account, AgentFile, FileList, Visibility } from "./schemas";

const MIB = 1024 * 1024;
const ONE_SHOT_LIMIT = 100 * MIB;
const PART_URL_BATCH = 100;
const COMPLETE_POLLS = 30;

export type AgentFSOptions = {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly runId?: string;
  readonly agentId?: string;
  readonly concurrency?: number;
  readonly multipartThreshold?: number;
  readonly retry?: Partial<RetryPolicy>;
};

export type UploadBody = Blob | ArrayBuffer | Uint8Array<ArrayBuffer> | string;

export type PutOptions = {
  readonly contentType?: string;
  readonly visibility?: Visibility;
  readonly expiresIn?: string;
  readonly label?: string;
  readonly replace?: boolean;
  readonly multipart?: boolean;
  readonly idempotencyKey?: string;
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  readonly signal?: AbortSignal;
};

export type ListOptions = {
  readonly project?: string;
  readonly prefix?: string;
  readonly path?: string;
  readonly q?: string;
  readonly runId?: string;
  readonly status?: "ready" | "trashed" | "uploading";
  readonly limit?: number;
  readonly cursor?: string;
};

type Json = Record<string, string | number | boolean | null | undefined>;

const toBlob = (body: UploadBody, contentType: string | undefined): Blob => {
  if (body instanceof Blob) return contentType && body.type !== contentType ? new Blob([body], { type: contentType }) : body;
  return new Blob([body], contentType ? { type: contentType } : {});
};

const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? "file";

export const createAgentFS = (options: AgentFSOptions = {}) => {
  const baseUrl = (options.baseUrl ?? "https://agentfs.cloud").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const policy: RetryPolicy = { ...defaultRetryPolicy, ...options.retry };
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const multipartThreshold = Math.min(options.multipartThreshold ?? 16 * MIB, ONE_SHOT_LIMIT);

  const headers = (extra: Record<string, string> = {}): Record<string, string> => {
    const result: Record<string, string> = { "user-agent": "agentfs-sdk", ...extra };
    if (options.apiKey) result.authorization = `Bearer ${options.apiKey}`;
    if (options.runId) result["x-run-id"] = options.runId;
    if (options.agentId) result["x-agent-id"] = options.agentId;
    return result;
  };

  const send = async (path: string, init: RequestInit & { readonly headers?: Record<string, string> } = {}): Promise<Response> => {
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: headers(init.headers) });
    if (!response.ok) throw await errorFromResponse(response, `${init.method ?? "GET"} ${path} failed with ${response.status}.`);
    return response;
  };

  const json = async <Schema extends z.ZodType>(schema: Schema, path: string, init?: RequestInit & { readonly headers?: Record<string, string> }): Promise<z.infer<Schema>> =>
    schema.parse(await (await send(path, init)).json());

  const jsonBody = (method: string, body: Json, signal?: AbortSignal): RequestInit & { readonly headers: Record<string, string> } => ({
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    ...(signal ? { signal } : {}),
  });

  const account = () => json(accountSchema, "/v1/me");

  const oneShot = async (path: string, blob: Blob, put: PutOptions): Promise<AgentFile> => {
    const form = new FormData();
    form.append("file", blob, baseName(path));
    if (options.apiKey) {
      if (path.includes("/")) form.append("path", path);
      if (put.visibility) form.append("visibility", put.visibility);
      if (put.expiresIn) form.append("expires_in", put.expiresIn);
      if (put.label) form.append("label", put.label);
      if (put.replace) form.append("if_exists", "replace");
    }
    const request = () =>
      json(fileSchema, "/v1/files", {
        method: "POST",
        body: form,
        headers: put.idempotencyKey ? { "idempotency-key": put.idempotencyKey } : {},
        ...(put.signal ? { signal: put.signal } : {}),
      });
    return put.idempotencyKey ? withRetry(request, policy, put.signal) : request();
  };

  const putBytes = async (url: string, bytes: Blob, part: string, signal: AbortSignal | undefined, withAuth: boolean): Promise<void> => {
    const response = await fetchImpl(url, {
      method: "PUT",
      body: bytes,
      headers: withAuth ? headers({ "content-length": String(bytes.size) }) : { "content-length": String(bytes.size) },
      ...(signal ? { signal } : {}),
    });
    if (response.ok) return;
    if (!withAuth && (response.status === 401 || response.status === 403)) throw new ExpiredUrlError(`Storage rejected ${part} with ${response.status}.`);
    throw await errorFromResponse(response, `Storage rejected ${part} with ${response.status}.`);
  };

  const sendParts = async (session: UploadSession, blob: Blob, put: PutOptions): Promise<void> => {
    const size = blob.size;
    const sizeOf = (part: number) => Math.min(part * session.part_size, size) - (part - 1) * session.part_size;
    const done = new Set(session.uploaded_parts.map((part) => part.part_number));
    let uploaded = [...done].reduce((sum, part) => sum + sizeOf(part), 0);
    put.onProgress?.(uploaded, size);
    const pending = Array.from({ length: session.total_parts }, (_, index) => index + 1).filter((part) => !done.has(part));
    const batches = new Map<number, Promise<Map<number, string>>>();
    const batchOf = (part: number) => Math.floor((part - 1) / PART_URL_BATCH);
    const partUrl = async (part: number, fresh: boolean): Promise<string> => {
      const index = batchOf(part);
      if (fresh) batches.delete(index);
      let batch = batches.get(index);
      if (!batch) {
        const from = index * PART_URL_BATCH + 1;
        const to = Math.min(from + PART_URL_BATCH - 1, session.total_parts);
        batch = withRetry(() => json(partUrlsSchema, `/v1/uploads/${session.id}/part-urls?from=${from}&to=${to}`), policy, put.signal)
          .then(({ parts }) => new Map(parts.map((entry) => [entry.part_number, entry.url])));
        batches.set(index, batch);
        batch.catch(() => batches.delete(index));
      }
      const url = (await batch).get(part);
      if (!url) throw new AgentFSError(502, "missing_part_url", `The server sent no URL for part ${part}.`, true, undefined);
      return url;
    };
    const sendPart = async (part: number) => {
      const bytes = blob.slice((part - 1) * session.part_size, (part - 1) * session.part_size + sizeOf(part));
      let fresh = false;
      await withRetry(async () => {
        try {
          if (session.transport === "worker") {
            await putBytes(`${baseUrl}/v1/uploads/${session.id}/parts/${part}`, bytes, `part ${part}`, put.signal, true);
          } else {
            await putBytes(await partUrl(part, fresh), bytes, `part ${part}`, put.signal, false);
          }
        } catch (error) {
          fresh = error instanceof ExpiredUrlError;
          throw error;
        }
      }, policy, put.signal);
      uploaded += sizeOf(part);
      put.onProgress?.(uploaded, size);
    };
    let next = 0;
    const worker = async () => {
      for (let part = pending[next++]; part !== undefined; part = pending[next++]) await sendPart(part);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  };

  const sendWhole = async (session: UploadSession, blob: Blob, put: PutOptions): Promise<void> => {
    let url = session.upload_url;
    await withRetry(async () => {
      if (!url) url = (await json(uploadSessionSchema, `/v1/uploads/${session.id}`)).upload_url;
      if (!url) throw new AgentFSError(409, "upload_not_active", `Upload ${session.id} has no upload URL.`, false, undefined);
      try {
        await putBytes(url, blob, "the file", put.signal, false);
      } catch (error) {
        if (error instanceof ExpiredUrlError) url = undefined;
        throw error;
      }
    }, policy, put.signal);
    put.onProgress?.(blob.size, blob.size);
  };

  const complete = async (id: string, signal: AbortSignal | undefined): Promise<AgentFile> => {
    for (let attempt = 0; attempt < COMPLETE_POLLS; attempt += 1) {
      const response = await withRetry(() => send(`/v1/uploads/${id}/complete`, { method: "POST", ...(signal ? { signal } : {}) }), policy, signal);
      if (response.status === 200) return fileSchema.parse(await response.json());
      await policy.sleep(1000);
    }
    throw new AgentFSError(504, "upload_still_completing", `Upload ${id} is still finishing. Check it later with get().`, true, undefined);
  };

  const session = async (path: string, blob: Blob, put: PutOptions): Promise<AgentFile> => {
    const fullPath = path.includes("/") ? path : `${(await account()).default_project ?? "default"}/${path}`;
    const created = await withRetry(() => json(uploadSessionSchema, "/v1/uploads", jsonBody("POST", {
      path: fullPath,
      size_bytes: blob.size,
      multipart: put.multipart ?? blob.size > multipartThreshold,
      content_type: put.contentType ?? (blob.type || undefined),
      visibility: put.visibility,
      expires_in: put.expiresIn,
      label: put.label,
    }, put.signal)), policy, put.signal);
    try {
      if (created.upload_url) await sendWhole(created, blob, put);
      else await sendParts(created, blob, put);
    } catch (error) {
      if (error instanceof AgentFSError && !error.retryable) await send(`/v1/uploads/${created.id}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    }
    return complete(created.id, put.signal);
  };

  return {
    account,

    async put(path: string, body: UploadBody, put: PutOptions = {}): Promise<AgentFile> {
      const blob = toBlob(body, put.contentType);
      if (!options.apiKey) {
        if (blob.size > ONE_SHOT_LIMIT) throw new AgentFSError(413, "api_key_required", "Uploads without an API key are limited to 100 MB.", false, undefined);
        return oneShot(path, blob, put);
      }
      if (put.replace) {
        if (blob.size > ONE_SHOT_LIMIT) throw new AgentFSError(413, "file_too_large", "Replacing a file is limited to 100 MB. Upload to a new path instead.", false, undefined);
        return oneShot(path, blob, put);
      }
      if (!put.multipart && blob.size <= multipartThreshold) return oneShot(path, blob, put);
      return session(path, blob, put);
    },

    get: (id: string) => json(fileSchema, `/v1/files/${encodeURIComponent(id)}`),

    async list(filters: ListOptions = {}) {
      const { runId, limit, ...rest } = filters;
      const query = new URLSearchParams(Object.entries(rest).filter((entry): entry is [string, string] => entry[1] !== undefined));
      if (runId) query.set("run_id", runId);
      if (limit !== undefined) query.set("limit", String(limit));
      const list = await json(fileListSchema, `/v1/files${query.size ? `?${query}` : ""}`);
      return { items: list.items, nextCursor: list.next_cursor };
    },

    read: (id: string) => send(`/v1/files/${encodeURIComponent(id)}/content`),

    rename: (id: string, name: string) => json(fileSchema, `/v1/files/${encodeURIComponent(id)}`, jsonBody("PATCH", { name })),

    async delete(id: string, { permanent = false }: { readonly permanent?: boolean } = {}): Promise<void> {
      await send(`/v1/files/${encodeURIComponent(id)}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
    },

    restore: (id: string) => json(fileSchema, `/v1/files/${encodeURIComponent(id)}/restore`, { method: "POST" }),

    async accessUrl(id: string, { expiresIn }: { readonly expiresIn?: string } = {}) {
      const result = await json(accessUrlSchema, `/v1/files/${encodeURIComponent(id)}/access`, jsonBody("POST", { expires_in: expiresIn }));
      return { url: result.url, expiresAt: result.expires_at };
    },

    async revokeAccess(id: string) {
      const result = await json(revokeSchema, `/v1/files/${encodeURIComponent(id)}/access/revoke`, { method: "POST" });
      return { accessVersion: result.access_version };
    },
  };
};

export type AgentFS = ReturnType<typeof createAgentFS>;
