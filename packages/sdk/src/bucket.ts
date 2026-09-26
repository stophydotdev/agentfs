import { checkPath, createClient, encodePath, type Client, type Source, type WriteOptions } from "./client";
import { BlobError } from "./errors";
import { checkMetadata } from "./metadata";
import type { RetryPolicy } from "./retry";
import {
  accountSchema,
  deletedSchema,
  fileListSchema,
  fileSchema,
  openUploadsSchema,
  projectSettingsSchema,
  s3CredentialsSchema,
  signedUrlSchema,
  uploadSessionSchema,
  uploadTokenSchema,
  type ProjectSettings,
  type StoredFile,
} from "./schemas";
import { checkContentType, expandContentTypes, SNIFF_BYTES } from "./sniff";
import { cacheControl, formatBytes, parseSize, wireCache, wireDuration, type CacheOption, type Duration, type Size } from "./units";

const ONE_REQUEST_LIMIT = 100 * 1024 * 1024;
const MULTIPART_THRESHOLD = 16_000_000;
const SINGLE_PUT_MAX = 5 * 1024 * 1024 * 1024;
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
  readonly enableTelemetry?: boolean;
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

export interface ListMultipartOptions {
  prefix?: string;
}

export interface AbortStaleMultipartOptions extends ListMultipartOptions {
  olderThan: Duration;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface S3Config {
  endpoint: () => Promise<{ url: URL }>;
  region: string;
  bucket: string;
  forcePathStyle: true;
  credentials: () => Promise<S3Credentials>;
}

const REFRESH_MARGIN_MS = 30_000;

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

type Resolved =
  | { readonly blob: Blob; readonly contentType: string | undefined }
  | { readonly stream: ReadableStream<Uint8Array>; readonly size: number | undefined; readonly contentType: string | undefined };

const resolveBody = (body: PutBody): Resolved => {
  if (body instanceof Request) {
    if (body.body === null || body.bodyUsed) throw new BlobError("empty_body", { message: "the request has no body" });
    const length = body.headers.get("content-length");
    return { stream: body.body, size: length !== null && /^\d+$/.test(length) ? Number(length) : undefined, contentType: body.headers.get("content-type") ?? undefined };
  }
  if (body instanceof Blob) return { blob: body, contentType: body.type || undefined };
  if (body instanceof ReadableStream) return { stream: body, size: undefined, contentType: undefined };
  if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { blob: new Blob([body]), contentType: undefined };
  throw new TypeError("put() body must be a Request, Blob, ArrayBuffer, typed array, string or ReadableStream");
};

const concat = (chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const peek = async (stream: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let ended = false;
  while (got < SNIFF_BYTES) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    chunks.push(value);
    got += value.byteLength;
  }
  const buffered = concat(chunks);
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (buffered.byteLength) controller.enqueue(buffered);
      if (ended) controller.close();
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head: buffered.subarray(0, SNIFF_BYTES), stream: replay };
};

const readAll = async (stream: ReadableStream<Uint8Array>, maxSize: number): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return concat(chunks);
    got += value.byteLength;
    if (got > maxSize) {
      await reader.cancel();
      throw new BlobError("too_large", { message: `body exceeds maxSize (${maxSize} bytes)` });
    }
    chunks.push(value);
  }
};

const limit = (stream: ReadableStream<Uint8Array>, maxSize: number): ReadableStream<Uint8Array> => {
  let seen = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxSize) throw new BlobError("too_large", { message: `body exceeds maxSize (${maxSize} bytes)` });
      controller.enqueue(chunk);
    },
  }));
};

const unwrap = (error: unknown): unknown =>
  !BlobError.is(error) && typeof error === "object" && error !== null && "cause" in error && BlobError.is(error.cause) ? error.cause : error;

const decodePath = (path: string): string => path.split("/").map(decodeURIComponent).join("/");

const wantsMultipart = (option: MultipartOption | undefined, size: number): boolean => {
  if (size > SINGLE_PUT_MAX) {
    if (option === false) {
      throw new BlobError("too_large", {
        message: `${formatBytes(size)} is over the ${formatBytes(SINGLE_PUT_MAX)} a single PUT can carry`,
        hint: "multipart: false forbids the parts this body needs",
      });
    }
    return true;
  }
  if (typeof option === "boolean") return option;
  return size > (option === undefined ? MULTIPART_THRESHOLD : parseSize(option, "multipart"));
};

export interface BucketInternals {
  readonly client: Client;
  readonly token: string;
  readonly baseUrl: string;
  readonly wire: (path: string) => Promise<string>;
  readonly project: () => Promise<string>;
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
  readonly #bucketName: string | undefined;

  constructor(options: BucketOptions) {
    if (!options.token) throw new BlobError("unauthorized", { message: "A token is required: pass { token } or set AGENTFS_TOKEN.", status: 401 });
    this.#client = createClient(options);
    this.#defaultCache = options.cache;
    if (options.bucket) this.#project = Promise.resolve(options.bucket);
    this.#bucketName = options.bucket;
    INTERNALS.set(this, {
      client: this.#client,
      token: options.token,
      baseUrl: (options.baseUrl ?? "https://agentfs.cloud").replace(/\/+$/, ""),
      wire: (path) => this.#wire(path),
      project: () => this.#full(""),
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
    return `${await this.#project}/${path}`;
  }

  async #wire(path: string): Promise<string> {
    return encodePath(await this.#full(checkPath(path)));
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
    checkPath(path);
    const allowed = options.contentTypes === undefined ? undefined : expandContentTypes(options.contentTypes);
    const maxSize = options.maxSize === undefined ? undefined : parseSize(options.maxSize, "maxSize");
    const resolved = resolveBody(body);
    const contentType = options.contentType ?? resolved.contentType ?? "application/octet-stream";
    let source: Source;
    if ("blob" in resolved) source = resolved.blob;
    else {
      const size = resolved.size ?? (options.size === undefined ? undefined : parseSize(options.size, "size"));
      if (size === undefined) {
        if (maxSize === undefined) throw new BlobError("length_required");
        source = new Blob([await readAll(resolved.stream, maxSize)]);
      } else source = { stream: resolved.stream, size };
    }
    if (maxSize !== undefined && source.size > maxSize) {
      if (!(source instanceof Blob)) await source.stream.cancel().catch(() => undefined);
      throw new BlobError("too_large", { message: `the body is ${formatBytes(source.size)}, over the ${formatBytes(maxSize)} limit` });
    }
    if (allowed) {
      if (source instanceof Blob) checkContentType(contentType, new Uint8Array(await source.slice(0, SNIFF_BYTES).arrayBuffer()), allowed);
      else {
        const peeked = await peek(source.stream);
        source = { stream: peeked.stream, size: source.size };
        try {
          checkContentType(contentType, peeked.head, allowed);
        } catch (error) {
          await peeked.stream.cancel().catch(() => undefined);
          throw error;
        }
      }
    }
    if (!(source instanceof Blob)) {
      if (source.size === 0) {
        await source.stream.cancel().catch(() => undefined);
        source = new Blob([]);
      } else if (maxSize !== undefined) source = { stream: limit(source.stream, maxSize), size: source.size };
    }
    const conditional = options.allowOverwrite === false || options.ifUnchanged !== undefined;
    if (options.multipart === true && conditional) {
      throw new BlobError("invalid_input", { message: "multipart: allowOverwrite: false and ifUnchanged are single-PUT only" });
    }
    const cache = options.cache ?? this.#defaultCache;
    const metadata = checkMetadata(options.metadata);
    const write: WriteOptions = {
      contentType,
      ...(cache === undefined ? {} : { cache: wireCache(cache) }),
      ...(metadata ? { metadata } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    };
    try {
      const stored = await this.#write(await this.#full(path), source, write, options, conditional);
      return { ...(await this.#object(stored)), contentType: stored.content_type };
    } catch (error) {
      if (!(source instanceof Blob)) await source.stream.cancel().catch(() => undefined);
      const cause = unwrap(error);
      if (!BlobError.is(cause)) throw cause;
      if (cause.code === "already_exists" || (cause.code === "conflict" && options.allowOverwrite === false)) {
        const head = await this.#head(path).catch(() => undefined);
        throw new BlobError("already_exists", {
          message: `${path} already exists`,
          cause,
          ...(head?.etag ? { etag: head.etag } : {}),
          ...(head ? { size: head.size } : {}),
        });
      }
      throw cause;
    }
  }

  async #write(full: string, source: Source, write: WriteOptions, options: PutOptions, conditional: boolean): Promise<StoredFile> {
    if (source.size > 0 && wantsMultipart(options.multipart, source.size) && !conditional) {
      return this.#client.upload(full, source, { ...write, multipart: true, ifExists: "replace" });
    }
    const ifMatch = options.ifUnchanged === undefined ? {} : { ifMatch: options.ifUnchanged };
    if (source.size <= ONE_REQUEST_LIMIT) {
      return this.#client.putFile(full, source, { ...write, ...ifMatch, ...(options.allowOverwrite === false ? { ifNoneMatch: true } : {}) });
    }
    if (source.size > SINGLE_PUT_MAX) {
      throw new BlobError("too_large", {
        message: `${formatBytes(source.size)} is over the ${formatBytes(SINGLE_PUT_MAX)} a single PUT can carry`,
        hint: "allowOverwrite: false and ifUnchanged are single-PUT only",
      });
    }
    return this.#client.upload(full, source, { ...write, ...ifMatch, multipart: false, ifExists: options.allowOverwrite === false ? "error" : "replace" });
  }

  async #head(path: string): Promise<{ etag: string; size: number } | undefined> {
    try {
      const response = await this.#client.send(`/v1/files/${await this.#wire(path)}`, { method: "HEAD" });
      return { etag: response.headers.get("etag") ?? "", size: Number(response.headers.get("content-length") ?? 0) };
    } catch (error) {
      if (BlobError.is(error) && error.code === "not_found") return undefined;
      throw error;
    }
  }

  async info(path: string): Promise<BlobInfo> {
    return this.#infoOf(path).catch((error: unknown) => {
      throw BlobError.is(error) && error.code === "not_found" ? new BlobError("not_found", { message: `${path} not found` }) : error;
    });
  }

  async #infoOf(path: string): Promise<BlobInfo> {
    return this.#info(await this.#client.json(fileSchema, `/v1/files/${await this.#wire(path)}?info`));
  }

  async get(path: string): Promise<BlobDownload> {
    const { meta, content } = await this.#client.download(`/v1/files/${await this.#wire(path)}`);
    if (!content.body) throw new BlobError("request_failed", { message: `${path} came back without a body`, status: 502 });
    const header = (name: string): string | null => meta.get(name) ?? content.headers.get(name);
    const url = header("x-agentfs-url") ?? undefined;
    const etag = header("etag") ?? "";
    const metadata: Record<string, string> = {};
    meta.forEach((value, name) => {
      if (name.startsWith("x-agentfs-meta-")) metadata[name.slice("x-agentfs-meta-".length)] = value;
    });
    const stored = header("x-agentfs-path");
    return {
      path: stored ? await this.#relative(decodePath(stored)) : path,
      ...(url ? { url, versionedUrl: `${url}?v=${encodeURIComponent(etag.replaceAll('"', ""))}` } : {}),
      size: Number(content.headers.get("content-length") ?? meta.get("content-length") ?? 0),
      etag,
      uploadedAt: new Date(header("last-modified") ?? Date.now()),
      contentType: content.headers.get("content-type") ?? meta.get("content-type") ?? "application/octet-stream",
      metadata,
      body: content.body,
    };
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#head(path)) !== undefined;
  }

  async list(options: ListOptions = {}): Promise<ListPage> {
    const query = new URLSearchParams({
      starts_with: await this.#full(options.prefix ?? ""),
      order: "path",
      limit: String(Math.min(Math.max(Math.floor(options.limit ?? LIST_LIMIT), 1), LIST_LIMIT)),
    });
    if (options.cursor) query.set("cursor", options.cursor);
    const page = await this.#client.json(fileListSchema, `/v1/files?${query}`);
    return { blobs: await Promise.all(page.items.map((file) => this.#object(file))), cursor: page.next_cursor ?? undefined };
  }

  async copy(from: string, to: string, options: CopyOptions = {}): Promise<BlobObject> {
    const copied = await this.#client.json(fileSchema, `/v1/files/${await this.#wire(from)}/copy`, {
      ...this.#client.jsonInit("POST", {
        to: await this.#wire(to),
        if_exists: "replace",
        content_type: options.contentType,
        cache: options.cache === undefined ? undefined : wireCache(options.cache),
        metadata: checkMetadata(options.metadata),
      }),
      idempotent: true,
    });
    return this.#object(copied);
  }

  async move(from: string, to: string, options: CopyOptions = {}): Promise<BlobObject> {
    if (options.contentType === undefined && options.cache === undefined && options.metadata === undefined) {
      const moved = await this.#client.json(fileSchema, `/v1/files/${await this.#wire(from)}/move`, this.#client.jsonInit("POST", { to: await this.#wire(to), if_exists: "replace" }));
      return this.#object(moved);
    }
    const copied = await this.copy(from, to, options);
    try {
      await this.del(from);
    } catch (error) {
      throw new BlobError("move_left_a_copy", { message: `moved ${from} to ${to} but could not delete the source`, cause: error });
    }
    return copied;
  }

  async updateJson<T = unknown>(path: string, fn: (previous: T | null) => T | Promise<T>, options: UpdateJsonOptions = {}): Promise<BlobObject> {
    const attempts = options.maxAttempts ?? 6;
    if (!Number.isInteger(attempts) || attempts < 1) throw new BlobError("invalid_input", { message: "maxAttempts must be a positive integer" });
    let lastError: BlobError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let previous: T | null = null;
      let etag: string | undefined;
      let metadata: Record<string, string> | undefined;
      try {
        const current = await this.get(path);
        const text = await new Response(current.body).text();
        previous = text.length ? JSON.parse(text) : null;
        etag = current.etag;
        metadata = current.metadata;
      } catch (error) {
        if (!BlobError.is(error) || error.code !== "not_found") throw error;
      }
      const next = await fn(previous);
      const keep = options.metadata ?? metadata;
      try {
        return await this.put(path, JSON.stringify(next), {
          contentType: "application/json",
          ...(options.cache === undefined ? {} : { cache: options.cache }),
          ...(keep ? { metadata: keep } : {}),
          ...(etag === undefined ? { allowOverwrite: false } : { ifUnchanged: etag }),
        });
      } catch (error) {
        if (!BlobError.is(error) || (error.code !== "conflict" && error.code !== "already_exists")) throw error;
        lastError = error;
        if (attempt < attempts) await this.#client.policy.sleep(Math.floor(this.#client.policy.random() * Math.min(4000, 25 * 2 ** attempt)));
      }
    }
    throw new BlobError("conflict", { message: `${path} kept changing across ${attempts} attempt${attempts === 1 ? "" : "s"}`, cause: lastError });
  }

  async del(target: DeleteTarget): Promise<void> {
    if (typeof target === "string") {
      try {
        await this.#client.send(`/v1/files/${await this.#wire(target)}`, { method: "DELETE" });
      } catch (error) {
        if (!BlobError.is(error) || error.code !== "not_found") throw error;
      }
      return;
    }
    if (Array.isArray(target)) {
      const failed: string[] = [];
      let cause: unknown;
      for (let index = 0; index < target.length; index += DELETE_BATCH) {
        const batch = target.slice(index, index + DELETE_BATCH);
        const paths = await Promise.all(batch.map((path) => this.#wire(path)));
        try {
          await this.#client.json(deletedSchema, "/v1/files/delete", this.#client.jsonInit("POST", { paths }));
        } catch (error) {
          cause = error;
          failed.push(...(await this.#survivors(batch, error)));
        }
      }
      if (failed.length) throw new BlobError("partial_delete", { message: `${failed.length} of ${target.length} paths were not deleted`, failed, cause });
      return;
    }
    if (typeof target?.prefix !== "string") throw new BlobError("invalid_input", { message: "del: expected a path, an array of paths, or { prefix }" });
    if (target.prefix === "" && target.all !== true) {
      throw new BlobError("invalid_input", {
        message: "del({ prefix: '' }) would delete every object in the bucket",
        hint: "pass { prefix: '', all: true } if that is what you mean",
      });
    }
    const startsWith = await this.#full(target.prefix);
    try {
      for (let more = true; more;) {
        more = (await this.#client.json(deletedSchema, "/v1/files/delete", this.#client.jsonInit("POST", { starts_with: startsWith }))).has_more;
      }
    } catch (error) {
      const failed: string[] = [];
      try {
        let cursor: string | undefined;
        do {
          const page = await this.list({ prefix: target.prefix, limit: LIST_LIMIT, ...(cursor ? { cursor } : {}) });
          failed.push(...page.blobs.map((blob) => blob.path));
          cursor = page.cursor;
        } while (cursor);
      } catch {
        throw error;
      }
      if (failed.length) throw new BlobError("partial_delete", { message: `${failed.length} paths under ${target.prefix} were not deleted`, failed, cause: error });
    }
  }

  async #survivors(paths: readonly string[], error: unknown): Promise<string[]> {
    const survivors: string[] = [];
    try {
      for (const path of paths) if (await this.exists(path)) survivors.push(path);
    } catch {
      throw error;
    }
    return survivors;
  }

  async publicUrl(path: string): Promise<string | undefined> {
    const settings = await this.#projectSettings();
    if (settings.default_visibility === "private") return undefined;
    const base = ACTIVE_EXTENSIONS.test(checkPath(path)) ? settings.urls.sandbox : settings.urls.files;
    return `${base}${encodePath(path)}`;
  }

  async signedReadUrl(path: string, options: SignedReadUrlOptions = {}): Promise<SignedReadUrl> {
    const signed = await this.#client.json(signedUrlSchema, `/v1/files/${await this.#wire(path)}/signed-url`, {
      ...this.#client.jsonInit("POST", {
        expires_in: wireDuration(options.expiresIn ?? "5m", "expiresIn", 1),
        download_as: options.downloadAs,
        content_type: options.contentType,
      }),
      idempotent: true,
    });
    return { url: signed.url, expiresAt: signed.expires_at ? new Date(signed.expires_at) : FAR_FUTURE };
  }

  async signedUploadUrl(path: string, options: SignedUploadUrlOptions = {}): Promise<SignedUploadUrl> {
    const size = options.size === undefined ? undefined : parseSize(options.size, "size");
    const visibility = (await this.#projectSettings()).default_visibility === "private" ? "private" : "public";
    const headers: Record<string, string> = {
      "content-type": options.contentType ?? "application/octet-stream",
      "cache-control": cacheControl(options.cache ?? this.#defaultCache, visibility),
    };
    if (size !== undefined) headers["content-length"] = String(size);
    const session = await this.#client.json(uploadSessionSchema, `/v1/files/${await this.#wire(path)}/upload-url`, this.#client.jsonInit("POST", {
      size_bytes: size,
      if_exists: options.allowOverwrite === false ? "error" : "replace",
      content_type: headers["content-type"],
      cache: headers["cache-control"],
      metadata: checkMetadata(options.metadata),
      expires_in: options.expiresIn === undefined ? undefined : wireDuration(options.expiresIn, "expiresIn", 1),
    }));
    if (!session.upload_url) throw new BlobError("request_failed", { message: "Direct upload is unavailable right now. Retry, or use put().", status: 503, retryable: true });
    return {
      url: session.upload_url,
      headers,
      expiresAt: new Date(session.upload_url_expires_at ?? session.expires_at ?? Date.now()),
    };
  }

  async listMultipartUploads(options: ListMultipartOptions = {}): Promise<MultipartUpload[]> {
    const query = options.prefix ? `?prefix=${encodeURIComponent(await this.#wire(options.prefix))}` : "";
    const open = await this.#client.json(openUploadsSchema, `/v1/uploads${query}`);
    return Promise.all(open.items.map(async (item) => ({ path: await this.#relative(item.path), uploadId: item.id, initiatedAt: new Date(item.created_at) })));
  }

  async abortMultipartUpload(upload: Pick<MultipartUpload, "uploadId">): Promise<void> {
    await this.#client.send(`/v1/uploads/${encodeURIComponent(upload.uploadId)}`, { method: "DELETE" });
  }

  async abortStaleMultipartUploads(options: AbortStaleMultipartOptions): Promise<MultipartUpload[]> {
    const aborted = await this.#client.json(openUploadsSchema, "/v1/uploads/abort-stale", this.#client.jsonInit("POST", {
      older_than: wireDuration(options.olderThan, "olderThan"),
      ...(options.prefix ? { prefix: await this.#wire(options.prefix) } : {}),
    }));
    return Promise.all(aborted.items.map(async (item) => ({ path: await this.#relative(item.path), uploadId: item.id, initiatedAt: new Date(item.created_at) })));
  }

  s3(): S3Config {
    const name = this.#bucketName;
    if (!name) throw new BlobError("invalid_input", { message: "s3() needs the bucket name: pass { bucket } to the Bucket or set AGENTFS_BUCKET" });
    let current: Promise<{ credentials: S3Credentials; endpoint: string }> | undefined;
    let expiresAt = 0;
    const fresh = (): Promise<{ credentials: S3Credentials; endpoint: string }> => {
      if (current && expiresAt - Date.now() >= REFRESH_MARGIN_MS) return current;
      expiresAt = Number.POSITIVE_INFINITY;
      current = this.#client.json(s3CredentialsSchema, "/v1/credentials", this.#client.jsonInit("POST", { expires_in: "3600s" })).then((minted) => {
        const credentials = {
          accessKeyId: minted.access_key_id,
          secretAccessKey: minted.secret_access_key,
          sessionToken: minted.session_token,
          expiration: new Date(minted.expiration),
        };
        expiresAt = credentials.expiration.getTime();
        return { credentials, endpoint: minted.endpoint };
      });
      current.catch(() => {
        current = undefined;
        expiresAt = 0;
      });
      return current;
    };
    return {
      endpoint: async () => ({ url: new URL((await fresh()).endpoint) }),
      region: "auto",
      bucket: name,
      forcePathStyle: true,
      credentials: async () => (await fresh()).credentials,
    };
  }

  async uploadToken(options: UploadTokenOptions): Promise<UploadToken> {
    const minted = await this.#client.json(uploadTokenSchema, "/v1/upload-tokens", this.#client.jsonInit("POST", {
      ...(options.path === undefined ? {} : { path: await this.#wire(options.path) }),
      ...(options.prefix === undefined ? {} : { prefix: await this.#wire(options.prefix) }),
      max_size: options.maxSize === undefined ? undefined : parseSize(options.maxSize, "maxSize"),
      content_types: options.contentTypes,
      expires_in: options.expiresIn === undefined ? undefined : wireDuration(options.expiresIn, "expiresIn", 1),
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
