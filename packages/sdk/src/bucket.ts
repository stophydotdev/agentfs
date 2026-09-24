import { createClient, encodePath, type Client } from "./client";
import { BlobError } from "./errors";
import type { RetryPolicy } from "./retry";
import {
  accountSchema,
  deletedSchema,
  fileListSchema,
  fileSchema,
  openUploadsSchema,
  projectSettingsSchema,
  signedUrlSchema,
  uploadSessionSchema,
  uploadTokenSchema,
  type ProjectSettings,
  type StoredFile,
} from "./schemas";
import { checkContentType, expandContentTypes, SNIFF_BYTES } from "./sniff";
import { formatBytes, parseSize, type CacheOption, type Duration, type Size } from "./units";

const ONE_REQUEST_LIMIT = 100 * 1024 * 1024;
const DEFAULT_MULTIPART = "16mb";
const LIST_LIMIT = 1000;
const ACTIVE_EXTENSIONS = /\.(html?|xhtml|svg|xml)$/i;
const DELETE_BATCH = 1000;
const FAR_FUTURE = new Date(8.64e15);

export type PutBody = Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer> | string | ReadableStream<Uint8Array> | Request;
export type MultipartOption = boolean | Size;

export interface BucketOptions {
  readonly token: string;
  readonly bucket?: string;
  readonly cache?: CacheOption;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly retry?: Partial<RetryPolicy>;
  readonly concurrency?: number;
}

export type FromEnvOptions = Omit<BucketOptions, "token">;

export interface BlobObject {
  path: string;
  url?: string;
  versionedUrl?: string;
  size: number;
  etag: string;
  uploadedAt: Date;
}

export interface CompletedBlob extends BlobObject {
  contentType: string;
}

export interface BlobInfo extends BlobObject {
  contentType: string;
  metadata: Record<string, string>;
}

export interface BlobDownload extends BlobInfo {
  body: ReadableStream<Uint8Array>;
}

export interface PutOptions {
  size?: number;
  contentType?: string;
  contentTypes?: readonly string[];
  maxSize?: Size;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  allowOverwrite?: boolean;
  ifUnchanged?: string;
  multipart?: MultipartOption;
  onProgress?: (uploaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListPage {
  blobs: BlobObject[];
  cursor: string | undefined;
}

export interface CopyOptions {
  contentType?: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
}

export interface UpdateJsonOptions {
  cache?: CacheOption;
  metadata?: Record<string, string>;
  maxAttempts?: number;
}

export interface SignedReadUrlOptions {
  expiresIn?: Duration;
  downloadAs?: string;
  contentType?: string;
}

export interface SignedReadUrl {
  url: string;
  expiresAt: Date;
}

export interface SignedUploadUrlOptions {
  expiresIn?: Duration;
  size?: Size;
  contentType?: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  allowOverwrite?: boolean;
}

export interface SignedUploadUrl {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface MultipartUpload {
  path: string;
  uploadId: string;
  initiatedAt: Date;
}

export interface AbortStaleMultipartOptions {
  olderThan: Duration;
  prefix?: string;
}

export type DeleteTarget = string | string[] | { prefix: string; all?: boolean };

export interface UploadTokenOptions {
  path?: string;
  prefix?: string;
  maxSize?: Size;
  contentTypes?: readonly string[];
  expiresIn?: Duration;
  callbackUrl?: string;
}

export interface UploadToken {
  token: string;
  path: string;
  expiresAt: Date;
  callbackSecret: string | undefined;
}

const envValue = (name: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;

const readCapped = async (stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer>[]> => {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new BlobError("too_large", { message: `The body is over the ${formatBytes(cap)} limit`, status: 413 });
    }
    chunks.push(new Uint8Array(value));
  }
};

const toBlob = async (body: PutBody | null | undefined, contentType: string | undefined, size: number | undefined, maxSize: number | undefined): Promise<Blob> => {
  if (body === null || body === undefined) throw new BlobError("empty_body", { message: "put() needs a body" });
  const typed = (parts: BlobPart[], type = contentType): Blob => new Blob(parts, type ? { type } : {});
  if (body instanceof Blob) return contentType && body.type !== contentType ? typed([body]) : body;
  if (!(body instanceof Request) && !(body instanceof ReadableStream)) return typed([body]);
  const type = contentType ?? (body instanceof Request ? body.headers.get("content-type") ?? undefined : undefined);
  const stream = body instanceof Request ? body.body : body;
  if (!stream) return typed([], type);
  const header = body instanceof Request ? body.headers.get("content-length") : null;
  const length = size ?? (header === null ? undefined : Number(header));
  if (length === undefined && maxSize === undefined) {
    throw new BlobError("length_required", { message: "A stream carries no length: pass size (exact) or maxSize (buffers up to the cap)", status: 411 });
  }
  const blob = typed(await readCapped(stream, length ?? maxSize ?? 0), type);
  if (length !== undefined && blob.size !== length) {
    throw new BlobError("invalid_input", { message: `The body is ${blob.size} bytes, not the declared ${length}` });
  }
  return blob;
};

const decodePath = (path: string): string => path.split("/").map(decodeURIComponent).join("/");



const multipartThreshold = (option: MultipartOption | undefined): number => {
  if (option === true) return 0;
  if (option === false) return Number.POSITIVE_INFINITY;
  return parseSize(option ?? DEFAULT_MULTIPART, "multipart");
};

export interface BucketInternals {
  readonly client: Client;
  readonly token: string;
  readonly baseUrl: string;
  readonly wire: (path: string) => Promise<string>;
  readonly completed: (file: StoredFile) => Promise<CompletedBlob>;
}

const INTERNALS = new WeakMap<Bucket, BucketInternals>();

export const internalsOf = (bucket: Bucket): BucketInternals => {
  const internals = INTERNALS.get(bucket);
  if (!internals) throw new TypeError("expected a Bucket");
  return internals;
};

export class Bucket {
  readonly #client: Client;
  readonly #defaultCache: CacheOption | undefined;
  #project: Promise<string> | undefined;
  #settings: Promise<ProjectSettings> | undefined;

  constructor(options: BucketOptions) {
    if (!options.token) throw new BlobError("unauthorized", { message: "A token is required: pass { token } or set AGENTFS_TOKEN.", status: 401 });
    this.#client = createClient(options);
    this.#defaultCache = options.cache;
    if (options.bucket) this.#project = Promise.resolve(options.bucket);
    INTERNALS.set(this, {
      client: this.#client,
      token: options.token,
      baseUrl: (options.baseUrl ?? "https://agentfs.cloud").replace(/\/+$/, ""),
      wire: (path) => this.#wire(path),
      completed: async (file) => ({ ...(await this.#object(file)), contentType: file.content_type }),
    });
  }

  static fromEnv(options?: FromEnvOptions): Bucket;
  static fromEnv(name: string | undefined, options?: FromEnvOptions): Bucket;
  static fromEnv(nameOrOptions: string | FromEnvOptions = "AGENTFS_TOKEN", options: FromEnvOptions = {}): Bucket {
    const name = typeof nameOrOptions === "string" ? nameOrOptions : "AGENTFS_TOKEN";
    const rest = typeof nameOrOptions === "string" ? options : nameOrOptions;
    const token = envValue(name) ?? envValue("AGENTFS_API_KEY") ?? "";
    const bucket = rest.bucket ?? envValue("AGENTFS_BUCKET");
    return new Bucket({ ...rest, token, ...(bucket ? { bucket } : {}) });
  }

  async #full(path: string): Promise<string> {
    this.#project ??= this.#client.json(accountSchema, "/v1/me").then((me) => me.default_project ?? "default");
    return `${await this.#project}/${path.replace(/^\/+/, "")}`;
  }

  async #wire(path: string): Promise<string> {
    return encodePath(await this.#full(path));
  }

  #projectSettings(): Promise<ProjectSettings> {
    this.#settings ??= this.#full("").then((full) => this.#client.json(projectSettingsSchema, `/v1/projects/${encodeURIComponent(full.slice(0, -1))}`));
    return this.#settings;
  }

  async #relative(stored: string): Promise<string> {
    const project = await this.#project;
    return project && stored.toLowerCase().startsWith(`${project.toLowerCase()}/`) ? stored.slice(project.length + 1) : stored;
  }

  async #object(file: StoredFile): Promise<BlobObject> {
    return {
      path: await this.#relative(file.path),
      ...(file.url ? { url: file.url } : {}),
      ...(file.versioned_url ? { versionedUrl: file.versioned_url } : {}),
      size: file.size_bytes,
      etag: file.etag ?? "",
      uploadedAt: new Date(file.updated_at ?? file.created_at),
    };
  }

  async #info(file: StoredFile): Promise<BlobInfo> {
    return { ...(await this.#object(file)), contentType: file.content_type, metadata: file.metadata ?? {} };
  }

  async put(path: string, body: PutBody, options: PutOptions = {}): Promise<CompletedBlob> {
    const allowed = options.contentTypes === undefined ? undefined : expandContentTypes(options.contentTypes);
    const maxSize = options.maxSize === undefined ? undefined : parseSize(options.maxSize, "maxSize");
    if (maxSize !== undefined && options.size !== undefined && options.size > maxSize) {
      throw new BlobError("too_large", { message: `The body is ${formatBytes(options.size)}, over the ${formatBytes(maxSize)} limit`, status: 413 });
    }
    const blob = await toBlob(body, options.contentType, options.size, maxSize);
    const contentType = options.contentType ?? (blob.type || "application/octet-stream");
    if (maxSize !== undefined && blob.size > maxSize) {
      throw new BlobError("too_large", { message: `The body is ${formatBytes(blob.size)}, over the ${formatBytes(maxSize)} limit`, status: 413 });
    }
    if (allowed) checkContentType(contentType, new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer()), allowed);
    const conditional = options.allowOverwrite === false || options.ifUnchanged !== undefined;
    if (options.multipart === true && conditional) {
      throw new BlobError("invalid_input", { message: "multipart: allowOverwrite: false and ifUnchanged are single-PUT only" });
    }
    const cache = options.cache ?? this.#defaultCache;
    const write = {
      contentType,
      ...(cache ? { cache } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    };
    const full = await this.#full(path);
    const inParts = !conditional && blob.size > 0 && (blob.size > multipartThreshold(options.multipart) || blob.size > ONE_REQUEST_LIMIT);
    if (!inParts && blob.size > ONE_REQUEST_LIMIT) {
      throw new BlobError("invalid_input", { message: "allowOverwrite: false and ifUnchanged work on files up to 100 MB" });
    }
    const stored = inParts
      ? await this.#client.uploadInParts(full, blob, { ...write, replace: true })
      : await this.#client.putFile(full, blob, {
          ...write,
          ...(options.allowOverwrite === false ? { ifNoneMatch: true } : {}),
          ...(options.ifUnchanged === undefined ? {} : { ifMatch: options.ifUnchanged }),
        });
    return { ...(await this.#object(stored)), contentType: stored.content_type };
  }

  async info(path: string): Promise<BlobInfo> {
    return this.#info(await this.#client.json(fileSchema, `/v1/files/${await this.#wire(path)}?info`));
  }

  async get(path: string): Promise<BlobDownload> {
    const response = await this.#client.send(`/v1/files/${await this.#wire(path)}`);
    if (!response.body) throw new BlobError("request_failed", { message: `${path} came back without a body`, status: 502 });
    const headers = response.headers;
    const url = headers.get("x-agentfs-url") ?? undefined;
    const etag = headers.get("etag") ?? "";
    const metadata: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (name.startsWith("x-agentfs-meta-")) metadata[name.slice("x-agentfs-meta-".length)] = value;
    });
    const stored = headers.get("x-agentfs-path");
    return {
      path: stored ? await this.#relative(decodePath(stored)) : path,
      ...(url ? { url, versionedUrl: `${url}?v=${encodeURIComponent(etag.replaceAll('"', ""))}` } : {}),
      size: Number(headers.get("content-length") ?? 0),
      etag,
      uploadedAt: new Date(headers.get("last-modified") ?? Date.now()),
      contentType: headers.get("content-type") ?? "application/octet-stream",
      metadata,
      body: response.body,
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.#client.send(`/v1/files/${await this.#wire(path)}`, { method: "HEAD" });
      return true;
    } catch (error) {
      if (BlobError.is(error) && error.code === "not_found") return false;
      throw error;
    }
  }

  async list(options: ListOptions = {}): Promise<ListPage> {
    const query = new URLSearchParams({ starts_with: await this.#full(options.prefix ?? ""), limit: String(Math.min(Math.max(options.limit ?? LIST_LIMIT, 1), LIST_LIMIT)) });
    if (options.cursor) query.set("cursor", options.cursor);
    const page = await this.#client.json(fileListSchema, `/v1/files?${query}`);
    return { blobs: await Promise.all(page.items.map((file) => this.#object(file))), cursor: page.next_cursor ?? undefined };
  }

  async copy(from: string, to: string, options: CopyOptions = {}): Promise<BlobObject> {
    const copied = await this.#client.json(fileSchema, `/v1/files/${await this.#wire(from)}/copy`, this.#client.jsonInit("POST", {
      to: await this.#wire(to),
      content_type: options.contentType,
      cache: options.cache,
      metadata: options.metadata,
    }));
    return this.#object(copied);
  }

  async move(from: string, to: string, options: CopyOptions = {}): Promise<BlobObject> {
    if (options.contentType === undefined && options.cache === undefined && options.metadata === undefined) {
      const moved = await this.#client.json(fileSchema, `/v1/files/${await this.#wire(from)}/move`, this.#client.jsonInit("POST", { to: await this.#wire(to) }));
      return this.#object(moved);
    }
    const copied = await this.copy(from, to, options);
    await this.del(from).catch((error: unknown) => {
      throw new BlobError("move_left_a_copy", { message: `${to} was written but ${from} could not be deleted: ${String(error)}`, status: 500 });
    });
    return copied;
  }

  async updateJson<T = unknown>(path: string, fn: (previous: T | null) => T | Promise<T>, options: UpdateJsonOptions = {}): Promise<BlobObject> {
    const attempts = options.maxAttempts ?? 6;
    for (let attempt = 1; ; attempt += 1) {
      const current = await this.get(path).catch((error: unknown) => {
        if (BlobError.is(error) && error.code === "not_found") return null;
        throw error;
      });
      const previous: T | null = current ? JSON.parse(await new Response(current.body).text()) : null;
      const next = await fn(previous);
      try {
        return await this.put(path, JSON.stringify(next), {
          contentType: "application/json",
          ...(current ? { ifUnchanged: current.etag } : { allowOverwrite: false }),
          ...(options.cache ? { cache: options.cache } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
        });
      } catch (error) {
        const raced = BlobError.is(error) && (error.code === "conflict" || error.code === "already_exists");
        if (!raced || attempt >= attempts) throw error;
        await this.#client.policy.sleep(Math.min(2000, 50 * 2 ** attempt) * this.#client.policy.random());
      }
    }
  }

  async del(target: DeleteTarget): Promise<void> {
    if (typeof target === "string") {
      await this.#client.send(`/v1/files/${await this.#wire(target)}`, { method: "DELETE" });
      return;
    }
    if (Array.isArray(target)) {
      const paths = await Promise.all(target.map((path) => this.#wire(path)));
      for (let index = 0; index < paths.length; index += DELETE_BATCH) {
        await this.#client.json(deletedSchema, "/v1/files/delete", this.#client.jsonInit("POST", { paths: paths.slice(index, index + DELETE_BATCH) }))
          .catch((error: unknown) => {
            if (index === 0) throw error;
            throw new BlobError("partial_delete", { message: `Deleted ${index} of ${paths.length} paths before failing: ${String(error)}`, status: 500 });
          });
      }
      return;
    }
    if (!target.prefix && !target.all) throw new BlobError("invalid_input", { message: "del({ prefix: \"\" }) deletes the whole bucket; pass all: true to mean it" });
    const startsWith = await this.#full(target.prefix);
    for (let more = true; more;) {
      more = (await this.#client.json(deletedSchema, "/v1/files/delete", this.#client.jsonInit("POST", { starts_with: startsWith }))).has_more;
    }
  }

  async publicUrl(path: string): Promise<string | undefined> {
    const settings = await this.#projectSettings();
    if (settings.default_visibility === "private") return undefined;
    const base = ACTIVE_EXTENSIONS.test(path) ? settings.urls.sandbox : settings.urls.files;
    return `${base}${encodePath(path)}`;
  }

  async signedReadUrl(path: string, options: SignedReadUrlOptions = {}): Promise<SignedReadUrl> {
    const signed = await this.#client.json(signedUrlSchema, `/v1/files/${await this.#wire(path)}/signed-url`, this.#client.jsonInit("POST", {
      expires_in: options.expiresIn ?? "1h",
      download_as: options.downloadAs,
      content_type: options.contentType,
    }));
    return { url: signed.url, expiresAt: signed.expires_at ? new Date(signed.expires_at) : FAR_FUTURE };
  }

  async signedUploadUrl(path: string, options: SignedUploadUrlOptions = {}): Promise<SignedUploadUrl> {
    const size = options.size === undefined ? undefined : parseSize(options.size, "size");
    const session = await this.#client.json(uploadSessionSchema, `/v1/files/${await this.#wire(path)}/upload-url`, this.#client.jsonInit("POST", {
      size_bytes: size,
      if_exists: options.allowOverwrite === false ? "error" : "replace",
      content_type: options.contentType,
      cache: options.cache ?? this.#defaultCache,
      metadata: options.metadata,
    }));
    if (!session.upload_url) throw new BlobError("request_failed", { message: "Direct upload is unavailable right now. Retry, or use put().", status: 503, retryable: true });
    return {
      url: session.upload_url,
      headers: size === undefined ? {} : { "content-length": String(size) },
      expiresAt: new Date(session.upload_url_expires_at ?? session.expires_at ?? Date.now()),
    };
  }

  async listMultipartUploads(options: { prefix?: string } = {}): Promise<MultipartUpload[]> {
    const query = options.prefix ? `?prefix=${encodeURIComponent(await this.#wire(options.prefix))}` : "";
    const open = await this.#client.json(openUploadsSchema, `/v1/uploads${query}`);
    return Promise.all(open.items.map(async (item) => ({ path: await this.#relative(item.path), uploadId: item.id, initiatedAt: new Date(item.created_at) })));
  }

  async abortMultipartUpload(upload: Pick<MultipartUpload, "uploadId">): Promise<void> {
    await this.#client.send(`/v1/uploads/${encodeURIComponent(upload.uploadId)}`, { method: "DELETE" });
  }

  async abortStaleMultipartUploads(options: AbortStaleMultipartOptions): Promise<MultipartUpload[]> {
    const aborted = await this.#client.json(openUploadsSchema, "/v1/uploads/abort-stale", this.#client.jsonInit("POST", {
      older_than: options.olderThan,
      ...(options.prefix ? { prefix: await this.#wire(options.prefix) } : {}),
    }));
    return Promise.all(aborted.items.map(async (item) => ({ path: await this.#relative(item.path), uploadId: item.id, initiatedAt: new Date(item.created_at) })));
  }

  async uploadToken(options: UploadTokenOptions): Promise<UploadToken> {
    const minted = await this.#client.json(uploadTokenSchema, "/v1/upload-tokens", this.#client.jsonInit("POST", {
      ...(options.path === undefined ? {} : { path: await this.#wire(options.path) }),
      ...(options.prefix === undefined ? {} : { prefix: await this.#wire(options.prefix) }),
      max_size: options.maxSize === undefined ? undefined : parseSize(options.maxSize, "maxSize"),
      content_types: options.contentTypes,
      expires_in: options.expiresIn,
      callback_url: options.callbackUrl,
    }));
    return {
      token: minted.token,
      path: minted.path,
      expiresAt: new Date(minted.expires_at),
      callbackSecret: minted.callback_secret ?? undefined,
    };
  }
}
