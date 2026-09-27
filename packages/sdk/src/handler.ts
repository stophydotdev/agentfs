import { Bucket, internalsOf, type CompletedBlob, type MultipartOption } from "./bucket";
import { BlobError } from "./errors";
import { checkMetadata } from "./metadata";
import { partUrlsSchema, uploadSessionSchema, uploadTokenSchema } from "./schemas";
import { checkContentType, expandContentTypes, SNIFF_BYTES } from "./sniff";
import { formatBytes, parseSize, wireCache, type CacheOption, type Size } from "./units";
import {
  fromBase64,
  toBase64,
  type ServedConstraints,
  type UploadFile,
  type UploadRouteTypes,
  type WireBeginResponse,
  type WireCancelResponse,
  type WireConstraintsResponse,
  type WireEndResponse,
  type WirePart,
  type WirePartsResponse,
  type WireRequest,
} from "./wire";

const PART_BATCH = 100;
const TOKEN_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_MULTIPART = "16mb";
const CONSTRAINTS_MAX_AGE = 60;
const SIZE_MISMATCH = new Set(["size_mismatch", "checksum_mismatch"]);
const ROUTE_NAME = /^[A-Za-z_][\w-]*$/;
const TOKEN_ENV = "AGENTFS_KEY";

const tokenFromEnv = (): string | undefined => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[TOKEN_ENV] || env?.AGENTFS_TOKEN || env?.AGENTFS_API_KEY || undefined;
};

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export interface StandardResult<Output> {
  readonly value?: Output;
  readonly issues?: readonly StandardIssue[];
}

export interface StandardSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

type OutputOf<TSchema> = TSchema extends StandardSchema<unknown, infer Output> ? Output : undefined;

export interface RouteConstraints {
  contentTypes?: readonly string[] | null;
  maxSize?: Size | null;
}

export interface BeforeUploadArgs<TCtx = unknown, TInput = undefined, TRoute extends string = string> {
  ctx: TCtx;
  route: TRoute;
  request: Request;
  file: UploadFile;
  input: TInput;
}

export interface BeforeUploadResult<TState = undefined> {
  path: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  constraints?: RouteConstraints;
  state?: TState;
}

export type UploadCompleteArgs<TCtx = unknown, TRoute extends string = string, TState = undefined> = CompletedBlob & {
  ctx: TCtx;
  route: TRoute;
  request: Request;
  file: UploadFile;
  uploadId: string;
  metadata: Record<string, string>;
  state: TState;
  multipartUploadId: string | undefined;
};

export interface UploadErrorArgs<TCtx = unknown, TRoute extends string = string> {
  ctx: TCtx | undefined;
  route: TRoute;
  request: Request;
  error: unknown;
  file?: UploadFile;
  path?: string;
  metadata?: Record<string, string>;
  state?: unknown;
}

type ErrorReturn = BlobError | Response | void | Promise<BlobError | Response | void>;

type BeforeUpload<TCtx, TInput, TState> = (args: BeforeUploadArgs<TCtx, TInput>) => BeforeUploadResult<TState> | Promise<BeforeUploadResult<TState>>;

interface RouteSettings<TCtx, TState, TData> {
  bucket?: Bucket;
  constraints?: RouteConstraints;
  multipart?: MultipartOption;
  proxy?: boolean;
  field?: string;
  onUploadComplete?: (args: UploadCompleteArgs<TCtx, string, TState>) => TData | Promise<TData>;
  onError?: (args: UploadErrorArgs<TCtx>) => ErrorReturn;
}

interface RouteHooks<TCtx, TInput, TState, TData> extends RouteSettings<TCtx, TState, TData> {
  onBeforeUpload?: BeforeUpload<TCtx, TInput, TState>;
}

export interface UploadRouteOptions<TCtx, TSchema extends StandardSchema | undefined, TState, TData>
  extends RouteHooks<TCtx, OutputOf<TSchema>, TState, TData> {
  input?: TSchema;
}

const BUILT = "__agentfsUploadOptions";

export interface UploadRouteDefinition<TInput = undefined, TData = void> {
  readonly __agentfsUploadRoute: UploadRouteTypes<TInput, TData, string>;
}

export interface UploadBuilder<TCtx> {
  <TSchema extends StandardSchema | undefined = undefined, TState = undefined, TData = void>(
    options: UploadRouteOptions<TCtx, TSchema, TState, TData>,
  ): UploadRouteDefinition<OutputOf<TSchema>, TData>;
}

export const uploadRoute = <TCtx = undefined>(): UploadBuilder<TCtx> =>
  ((options: UploadRouteOptions<TCtx, StandardSchema | undefined, unknown, unknown>) => ({ [BUILT]: options })) as unknown as UploadBuilder<TCtx>;

type AnyHooks = UploadRouteOptions<unknown, StandardSchema | undefined, unknown, unknown>;

type DataOf<R, TDefault> = R extends UploadRouteDefinition<unknown, infer TData> ? TData
  : R extends { onUploadComplete: (...args: never[]) => infer TData } ? Awaited<TData> : TDefault;
type InputOf<R, TDefault> = R extends UploadRouteDefinition<infer TInput, unknown> ? TInput : TDefault;

export type HandlerRoutes<TRoutes, TData, TInput> = string extends keyof TRoutes
  ? { readonly "": UploadRouteDefinition<TInput, TData> }
  : { readonly [K in keyof TRoutes]: UploadRouteDefinition<InputOf<TRoutes[K], TInput>, DataOf<TRoutes[K], TData>> };

export type UploadRouteConfig<TCtx = unknown, TInput = undefined> =
  | (RouteHooks<TCtx, TInput, unknown, unknown> & { input?: StandardSchema })
  | UploadRouteDefinition<unknown, unknown>;

type OwnBeforeUploadRouteConfig<TCtx, TInput> =
  | (RouteHooks<TCtx, TInput, unknown, unknown> & { input?: StandardSchema; onBeforeUpload: BeforeUpload<TCtx, TInput, unknown> })
  | UploadRouteDefinition<unknown, unknown>;

interface HandlerSettings<TCtx, TData, TSchema extends StandardSchema | undefined> extends RouteSettings<Awaited<TCtx>, unknown, TData> {
  context?: (request: Request) => TCtx;
  input?: TSchema;
  endpoint?: string;
}

export type UploadHandlerOptions<TCtx, TRoutes, TData, TSchema extends StandardSchema | undefined> = HandlerSettings<TCtx, TData, TSchema> & (
  | {
    onBeforeUpload: BeforeUpload<Awaited<TCtx>, OutputOf<TSchema>, unknown>;
    routes?: TRoutes & Record<string, UploadRouteConfig<Awaited<TCtx>, OutputOf<TSchema>>>;
  }
  | {
    onBeforeUpload?: undefined;
    routes: TRoutes & Record<string, OwnBeforeUploadRouteConfig<Awaited<TCtx>, OutputOf<TSchema>>>;
  }
);

export interface UploadHandler<TRoutes = Record<string, UploadRouteDefinition<unknown, unknown>>, TCtx = unknown> {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  readonly __agentfsUploadHandler: TRoutes;
  readonly __agentfsUploadContext: TCtx;
}

interface Mounted extends AnyHooks {
  bucket: Bucket;
  name: string;
  id: string;
  limits: ServedConstraints;
  constraintsBody: string;
  constraintsEtag: string;
}

interface Claims {
  b: string;
  r: string;
  u: string;
  path: string;
  file: UploadFile;
  metadata: Record<string, string>;
  state: unknown;
  multipart: boolean;
  exp: number;
}

interface Details {
  file?: UploadFile;
  path?: string;
  metadata?: Record<string, string>;
  state?: unknown;
}

type Phase<TPhase extends WireRequest["phase"]> = Extract<WireRequest, { phase: TPhase }>;

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unbase64url = (value: string): Uint8Array => fromBase64(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));

const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const signingKey = async (token: string): Promise<CryptoKey> => {
  const secret = await crypto.subtle.digest("SHA-256", encoder.encode(`agentfs-upload-handler:${token}`));
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

const signClaims = async (token: string, claims: Claims): Promise<string> => {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign("HMAC", await signingKey(token), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(mac))}`;
};

const readClaims = async (token: string, completionToken: string): Promise<Claims | undefined> => {
  const [payload, signature, extra] = completionToken.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  try {
    if (!await crypto.subtle.verify("HMAC", await signingKey(token), new Uint8Array(unbase64url(signature)), encoder.encode(payload))) return undefined;
    const claims: Claims = JSON.parse(new TextDecoder().decode(unbase64url(payload)));
    return claims;
  } catch {
    return undefined;
  }
};

const toResponse = (error: BlobError): Response => Response.json(error.toJSON(), { status: error.status });

const statusOf = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const { status } = error;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600 ? status : undefined;
};

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message ? error.message : "request failed";

const answerError = async (error: unknown, onError: ((error: unknown) => ErrorReturn) | undefined): Promise<Response> => {
  const mapped = onError ? await onError(error) : undefined;
  if (mapped instanceof Response) return mapped;
  if (BlobError.is(mapped)) return toResponse(mapped);
  if (BlobError.is(error)) return toResponse(error);
  const status = statusOf(error);
  if (status === undefined) throw error;
  return toResponse(BlobError.fromStatus(status, { message: messageOf(error) }));
};

const resolve = (constraints: RouteConstraints | undefined): ServedConstraints => ({
  ...(constraints?.contentTypes ? { contentTypes: expandContentTypes(constraints.contentTypes) } : {}),
  ...(constraints?.maxSize === undefined || constraints.maxSize === null ? {} : { maxSize: parseSize(constraints.maxSize, "maxSize") }),
});

const mergeConstraints = (base: RouteConstraints | undefined, own: RouteConstraints | undefined): RouteConstraints => ({
  ...base,
  ...(own?.contentTypes === undefined ? {} : { contentTypes: own.contentTypes }),
  ...(own?.maxSize === undefined ? {} : { maxSize: own.maxSize }),
});

const narrow = (route: ServedConstraints, own: RouteConstraints): ServedConstraints => {
  const narrowed = resolve(own);
  if (narrowed.maxSize !== undefined && route.maxSize !== undefined && narrowed.maxSize > route.maxSize) {
    throw new TypeError(`onBeforeUpload widened maxSize (${narrowed.maxSize} > ${route.maxSize})`);
  }
  const allowed = route.contentTypes;
  const wider = allowed && narrowed.contentTypes ? narrowed.contentTypes.filter((type) => !allowed.includes(type)) : [];
  if (wider.length) throw new TypeError(`onBeforeUpload widened contentTypes (${wider.join(", ")})`);
  return narrowed;
};

const enforce = (limits: ServedConstraints, file: UploadFile, head: Uint8Array | undefined): void => {
  if (limits.maxSize !== undefined && file.size > limits.maxSize) {
    throw new BlobError("too_large", { message: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(limits.maxSize)} limit` });
  }
  if (limits.contentTypes) checkContentType(file.type, head, limits.contentTypes);
};

const readFile = (raw: unknown): UploadFile => {
  if (typeof raw !== "object" || raw === null || !("name" in raw) || typeof raw.name !== "string" || !("size" in raw)
    || typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 0) {
    throw new BlobError("invalid_input", { message: "file must be { name, type, size }" });
  }
  const declared = "type" in raw && typeof raw.type === "string" ? raw.type.split(";", 1)[0]?.trim().toLowerCase() : undefined;
  return { name: raw.name, type: declared || "application/octet-stream", size: raw.size };
};

const readHead = (raw: unknown): Uint8Array | undefined => {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return fromBase64(raw.slice(0, Math.ceil(SNIFF_BYTES / 3) * 4)).slice(0, SNIFF_BYTES);
  } catch {
    return undefined;
  }
};

const threshold = (option: MultipartOption | undefined): number =>
  option === true ? 0 : option === false ? Number.POSITIVE_INFINITY : parseSize(option ?? DEFAULT_MULTIPART, "multipart");

const validateInput = async (schema: StandardSchema | undefined, value: unknown): Promise<unknown> => {
  if (!schema) {
    if (value !== undefined) throw new BlobError("invalid_input", { message: "this route takes no input" });
    return undefined;
  }
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const where = (path: StandardIssue["path"]): string =>
      path?.length ? `${path.map((key) => typeof key === "object" ? String(key.key) : String(key)).join(".")}: ` : "";
    throw new BlobError("invalid_input", { message: result.issues.map((issue) => where(issue.path) + issue.message).join("; ") });
  }
  return result.value;
};

const decide = async (route: Mounted, args: BeforeUploadArgs<unknown, unknown>): Promise<BeforeUploadResult<unknown>> => {
  const decided = route.onBeforeUpload ? await route.onBeforeUpload(args) : undefined;
  if (!decided || typeof decided.path !== "string") throw new TypeError("onBeforeUpload must return { path }");
  const metadata = checkMetadata(decided.metadata);
  return metadata ? { ...decided, metadata } : decided;
};

const mismatched = (error: unknown, size: number): unknown =>
  BlobError.is(error) && ((error.apiCode !== undefined && SIZE_MISMATCH.has(error.apiCode)) || /sizes differ/i.test(error.message))
    ? new BlobError("signature_mismatch", { message: `the stored bytes do not match the ${size} declared`, cause: error })
    : error;

const discard = async (bucket: Bucket, path: string): Promise<void> => {
  await bucket.del(path).catch((error: unknown) => {
    console.error(`[agentfs] refused upload ${JSON.stringify(path)} could not be deleted and is still stored`, error);
  });
};

const settle = async <T>(bucket: Bucket, path: string, run: () => T | Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    await discard(bucket, path);
    throw error;
  }
};

const routeName = (request: Request): string => {
  try {
    return new URL(request.url).searchParams.get("route") ?? "";
  } catch {
    return "";
  }
};

export const uploadHandler = <
  TRoutes extends Record<string, object>,
  TCtx = undefined,
  TData = void,
  TSchema extends StandardSchema | undefined = undefined,
>(
  options: UploadHandlerOptions<TCtx, TRoutes, TData, TSchema>,
): UploadHandler<HandlerRoutes<TRoutes, TData, OutputOf<TSchema>>, Awaited<TCtx>> => {
  const { routes, context, endpoint, ...defaults } = options;
  const table = new Map<string, Mounted>();
  const named = Object.entries((routes ?? {}) as Record<string, AnyHooks | { [BUILT]: AnyHooks }>);
  if (routes !== undefined && named.length === 0) {
    throw new TypeError("uploadHandler was given an empty routes map: name at least one route, or omit routes to make the handler the route");
  }

  let envBucket: Bucket | undefined;
  const fallbackBucket = (name: string): Bucket => {
    if (!tokenFromEnv()) {
      const where = routes === undefined ? "uploadHandler has no bucket" : `upload route ${JSON.stringify(name)} has no bucket`;
      throw new TypeError(`${where} and ${TOKEN_ENV} is not set: set it, or pass bucket (on Workers it has to be bucket: new Bucket({ token: env.${TOKEN_ENV} }))`);
    }
    envBucket ??= Bucket.fromEnv();
    return envBucket;
  };

  const mount = (name: string, own: AnyHooks): Mounted => {
    const merged: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(own)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
    const hooks = merged as AnyHooks;
    const limits = resolve(mergeConstraints(defaults.constraints, own.constraints));
    const constraintsBody = JSON.stringify({ constraints: limits } satisfies WireConstraintsResponse);
    return {
      ...hooks,
      bucket: hooks.bucket ?? fallbackBucket(name),
      name,
      id: hash(JSON.stringify([endpoint ? `${endpoint}?route=${name}` : name, limits.contentTypes ?? null, limits.maxSize ?? null, hooks.input !== undefined])),
      limits,
      constraintsBody,
      constraintsEtag: `"${hash(constraintsBody)}"`,
    };
  };

  if (named.length === 0) table.set("", mount("", {}));
  for (const [name, route] of named) {
    if (!ROUTE_NAME.test(name)) throw new TypeError(`upload route names must match ${String(ROUTE_NAME)}: ${JSON.stringify(name)} does not`);
    table.set(name, mount(name, BUILT in route ? route[BUILT] : route));
  }

  const bucketId = (bucket: Bucket): Promise<string> => internalsOf(bucket).project();

  const notFound = (request: Request, name: string): Promise<Response> => {
    const onError = defaults.onError;
    const error = new BlobError("not_found", { message: "unknown upload route" });
    return answerError(error, onError ? (thrown) => onError({ ctx: undefined, route: name, request, error: thrown }) : undefined);
  };

  const verify = async (route: Mounted, bucket: Bucket, completionToken: unknown, details: Details): Promise<Claims> => {
    if (typeof completionToken !== "string") throw new BlobError("invalid_input", { message: "completionToken is required" });
    const internals = internalsOf(bucket);
    const claims = await readClaims(internals.token, completionToken);
    if (!claims || claims.b !== await bucketId(bucket) || claims.r !== route.id) {
      throw new BlobError("forbidden", { message: "completionToken is not valid for this route" });
    }
    if (claims.exp < Date.now()) throw new BlobError("forbidden", { message: "completionToken has expired" });
    details.path = claims.path;
    details.state = claims.state;
    return claims;
  };

  const plan = async (bucket: Bucket, sessionId: string, path: string, from: number): Promise<WirePartsResponse> => {
    const { client, baseUrl, wire } = internalsOf(bucket);
    const session = await client.json(uploadSessionSchema, `/v1/uploads/${encodeURIComponent(sessionId)}`);
    const size = session.expected_size_bytes ?? 0;
    const landed = session.uploaded_parts.map((part) => ({ n: part.part_number, etag: part.etag ?? "" }));
    if (session.upload_url) {
      return { parts: from > 1 ? [] : [{ n: 1, url: session.upload_url }], partSize: size, size, multipart: false, landed: [] };
    }
    const to = Math.min(from + PART_BATCH - 1, session.total_parts);
    if (session.transport === "s3") {
      const urls = await client.json(partUrlsSchema, `/v1/uploads/${encodeURIComponent(sessionId)}/part-urls?from=${from}&to=${to}`);
      return { parts: urls.parts.map((part) => ({ n: part.part_number, url: part.url })), partSize: session.part_size, size, multipart: true, landed };
    }
    const token = await client.json(uploadTokenSchema, "/v1/upload-tokens", client.jsonInit("POST", { path: await wire(path), expires_in: "24h" }));
    const headers = { authorization: `Bearer ${token.token}` };
    const parts: WirePart[] = Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => ({
      n: from + index,
      url: `${baseUrl}/v1/uploads/${encodeURIComponent(sessionId)}/parts/${from + index}`,
      headers,
    }));
    return { parts, partSize: session.part_size, size, multipart: true, landed };
  };

  const begin = async (request: Request, route: Mounted, ctx: unknown, body: Phase<"begin">, details: Details): Promise<WireBeginResponse> => {
    const file = readFile(body.file);
    details.file = file;
    if (file.size === 0) throw new BlobError("empty_body");
    const head = readHead(body.head);
    enforce(route.limits, file, head);
    const input = await validateInput(route.input, body.input);
    const decided = await decide(route, { ctx, route: route.name, request, file, input });
    details.path = decided.path;
    details.state = decided.state;
    if (decided.constraints) enforce(narrow(route.limits, decided.constraints), file, head);
    const metadata = decided.metadata ?? {};
    details.metadata = metadata;
    const bucket = route.bucket;
    const { client, token, wire } = internalsOf(bucket);
    const session = await client.json(uploadSessionSchema, "/v1/uploads", client.jsonInit("POST", {
      path: await wire(decided.path),
      size_bytes: file.size,
      multipart: file.size > threshold(route.multipart),
      if_exists: "replace",
      content_type: file.type,
      infer_content_type: false,
      cache: decided.cache === undefined ? undefined : wireCache(decided.cache),
      metadata: decided.metadata,
    }));
    const upload = await plan(bucket, session.id, decided.path, 1);
    const claims: Claims = {
      b: await bucketId(bucket),
      r: route.id,
      u: session.id,
      path: decided.path,
      file,
      metadata,
      state: decided.state,
      multipart: upload.multipart,
      exp: Date.now() + TOKEN_TTL_MS,
    };
    return {
      completionToken: await signClaims(token, claims),
      path: decided.path,
      upload: { partSize: upload.partSize, parts: upload.parts, multipart: upload.multipart },
    };
  };

  const parts = async (route: Mounted, body: Phase<"parts">, details: Details): Promise<WirePartsResponse> => {
    const bucket = route.bucket;
    const claims = await verify(route, bucket, body.completionToken, details);
    const from = Number.isInteger(body.from) && body.from >= 1 ? body.from : 1;
    return plan(bucket, claims.u, claims.path, from);
  };

  const end = async (request: Request, route: Mounted, ctx: unknown, body: Phase<"end">, details: Details): Promise<WireEndResponse> => {
    const bucket = route.bucket;
    const internals = internalsOf(bucket);
    const claims = await verify(route, bucket, body.completionToken, details);
    details.file = claims.file;
    const stored = await internals.client.complete(claims.u, undefined).catch((error: unknown) => {
      throw mismatched(error, claims.file.size);
    });
    const blob = await internals.completed(stored);
    if (blob.size !== claims.file.size) {
      await discard(bucket, claims.path);
      throw new BlobError("signature_mismatch", { message: `stored ${blob.size} bytes, ${claims.file.size} were declared` });
    }
    details.metadata = claims.metadata;
    const complete = route.onUploadComplete;
    const data = complete
      ? await settle(bucket, claims.path, () => complete({
        ...blob,
        ctx,
        route: route.name,
        request,
        file: claims.file,
        uploadId: claims.u,
        metadata: claims.metadata,
        state: claims.state,
        multipartUploadId: claims.multipart ? claims.u : undefined,
      }))
      : undefined;
    return { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
  };

  const cancel = async (route: Mounted, body: Phase<"cancel">, details: Details): Promise<WireCancelResponse> => {
    const bucket = route.bucket;
    const claims = await verify(route, bucket, body.completionToken, details);
    await internalsOf(bucket).client.send(`/v1/uploads/${encodeURIComponent(claims.u)}`, { method: "DELETE" });
    return { ok: true };
  };

  const proxied = async (request: Request, route: Mounted, ctx: unknown, details: Details): Promise<WireEndResponse> => {
    const contentType = request.headers.get("content-type") ?? "";
    const form = contentType.startsWith("multipart/form-data") ? await request.formData() : null;
    const part = form?.get(route.field ?? "file");
    const body = form ? (part instanceof File ? part : null) : request;
    if (!body) throw new BlobError("empty_body", { message: `No file in the ${route.field ?? "file"} field` });
    const declared = request.headers.get("content-length");
    const file: UploadFile = body instanceof File
      ? { name: body.name, type: body.type, size: body.size }
      : {
          name: decodeURIComponent(request.headers.get("x-upload-name") ?? "file"),
          type: contentType || "application/octet-stream",
          size: declared === null ? 0 : Number(declared),
        };
    details.file = file;
    const input = await validateInput(route.input, form ? JSON.parse(String(form.get("input") ?? "null")) ?? undefined : JSON.parse(decodeURIComponent(request.headers.get("x-upload-input") ?? "null")) ?? undefined);
    const decided = await decide(route, { ctx, route: route.name, request, file, input });
    details.path = decided.path;
    details.state = decided.state;
    const limits = decided.constraints ? narrow(route.limits, decided.constraints) : route.limits;
    const bucket = route.bucket;
    const streamed = body instanceof File || declared !== null || route.limits.maxSize !== undefined || limits.maxSize !== undefined ? body : await request.blob();
    const blob = await bucket.put(decided.path, streamed, {
      contentType: file.type || "application/octet-stream",
      ...(body instanceof File || declared === null ? {} : { size: file.size }),
      ...(limits.maxSize === undefined ? {} : { maxSize: limits.maxSize }),
      ...(limits.contentTypes ? { contentTypes: limits.contentTypes } : {}),
      ...(decided.cache ? { cache: decided.cache } : {}),
      ...(decided.metadata ? { metadata: decided.metadata } : {}),
    });
    const metadata = decided.metadata ?? {};
    details.metadata = metadata;
    const complete = route.onUploadComplete;
    const data = complete
      ? await settle(bucket, decided.path, () => complete({
        ...blob,
        ctx,
        route: route.name,
        request,
        file,
        uploadId: blob.etag,
        metadata,
        state: decided.state,
        multipartUploadId: undefined,
      }))
      : undefined;
    return { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
  };

  const GET = async (request: Request): Promise<Response> => {
    const name = routeName(request);
    const route = table.get(name);
    if (!route) return notFound(request, name);
    const headers = { "content-type": "application/json", "cache-control": `public, max-age=${CONSTRAINTS_MAX_AGE}`, etag: route.constraintsEtag };
    if (request.headers.get("if-none-match") === route.constraintsEtag) return new Response(null, { status: 304, headers });
    return new Response(route.constraintsBody, { headers });
  };

  const dispatch = async (request: Request, route: Mounted, ctx: unknown, details: Details): Promise<unknown> => {
    if (route.proxy) return proxied(request, route, ctx, details);
    const body: WireRequest | null | undefined = await request.json().catch(() => undefined);
    if (typeof body !== "object" || body === null || typeof body.phase !== "string") {
      throw new BlobError("invalid_input", { message: "expected a JSON body with a phase" });
    }
    const phase: string = body.phase;
    switch (body.phase) {
      case "begin":
        return begin(request, route, ctx, body, details);
      case "parts":
        return parts(route, body, details);
      case "end":
        return end(request, route, ctx, body, details);
      case "cancel":
        return cancel(route, body, details);
      default:
        throw new BlobError("invalid_input", { message: `unknown phase ${phase}` });
    }
  };

  const POST = async (request: Request): Promise<Response> => {
    const name = routeName(request);
    const route = table.get(name);
    if (!route) return notFound(request, name);
    const details: Details = {};
    let ctx: unknown;
    const onError = route.onError;
    try {
      ctx = context ? await context(request) : undefined;
      return Response.json(await dispatch(request, route, ctx, details));
    } catch (error) {
      return answerError(error, onError ? (thrown) => onError({ ctx, route: name, request, error: thrown, ...details }) : undefined);
    }
  };

  return { GET, POST } as UploadHandler<HandlerRoutes<TRoutes, TData, OutputOf<TSchema>>, Awaited<TCtx>>;
};

export type AnyUploadHandler = UploadHandler<Record<string, UploadRouteDefinition<unknown, unknown>>, unknown>;
