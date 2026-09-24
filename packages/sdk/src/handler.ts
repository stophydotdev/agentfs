import { Bucket, internalsOf, type CompletedBlob, type MultipartOption } from "./bucket";
import { BlobError } from "./errors";
import { partUrlsSchema, uploadSessionSchema, uploadTokenSchema } from "./schemas";
import { checkContentType, expandContentTypes } from "./sniff";
import { uniquePath } from "./unique-path";
import { parseSize, type CacheOption, type Size } from "./units";
import {
  fromBase64,
  toBase64,
  type ServedConstraints,
  type UploadFile,
  type UploadRouteTypes,
  type WireBeginResponse,
  type WireEndResponse,
  type WirePart,
  type WirePartsResponse,
  type WireRequest,
} from "./wire";

const PART_BATCH = 100;
const TOKEN_TTL_SECONDS = 24 * 3600;
const DEFAULT_MULTIPART = "16mb";

export interface StandardResult<Output> {
  readonly value?: Output;
  readonly issues?: readonly { readonly message: string }[];
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

interface RouteHooks<TCtx, TInput, TState, TData> {
  bucket?: Bucket;
  constraints?: RouteConstraints;
  multipart?: MultipartOption;
  proxy?: boolean;
  field?: string;
  onBeforeUpload?: (args: BeforeUploadArgs<TCtx, TInput>) => BeforeUploadResult<TState> | Promise<BeforeUploadResult<TState>>;
  onUploadComplete?: (args: UploadCompleteArgs<TCtx, string, TState>) => TData | Promise<TData>;
  onError?: (args: UploadErrorArgs<TCtx>) => ErrorReturn;
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

export interface UploadHandlerOptions<TCtx, TRoutes, TData, TSchema extends StandardSchema | undefined>
  extends RouteHooks<Awaited<TCtx>, OutputOf<TSchema>, unknown, TData> {
  context?: (request: Request) => TCtx;
  input?: TSchema;
  routes?: TRoutes & Record<string, UploadRouteConfig<Awaited<TCtx>, OutputOf<TSchema>>>;
}

export interface UploadHandler<TRoutes = Record<string, UploadRouteDefinition<unknown, unknown>>, TCtx = unknown> {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  readonly __agentfsUploadHandler: TRoutes;
  readonly __agentfsUploadContext: TCtx;
}

interface Mounted extends AnyHooks {
  name: string;
}

interface Claims {
  u: string;
  p: string;
  r: string;
  f: UploadFile;
  m: Record<string, string>;
  s: unknown;
  x: number;
}

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unbase64url = (value: string): Uint8Array => fromBase64(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));

const signingKey = async (token: string): Promise<CryptoKey> => {
  const secret = await crypto.subtle.digest("SHA-256", encoder.encode(`agentfs-upload-handler:${token}`));
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

const signClaims = async (token: string, claims: Claims): Promise<string> => {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign("HMAC", await signingKey(token), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(mac))}`;
};

const readClaims = async (token: string, completionToken: string): Promise<Claims> => {
  const [payload, signature] = completionToken.split(".");
  const valid = payload && signature
    && await crypto.subtle.verify("HMAC", await signingKey(token), new Uint8Array(unbase64url(signature)), encoder.encode(payload));
  if (!valid) throw new BlobError("unauthorized", { message: "The completion token is not valid", status: 401 });
  const claims: Claims = JSON.parse(new TextDecoder().decode(unbase64url(payload)));
  if (claims.x < Date.now() / 1000) throw new BlobError("unauthorized", { message: "The completion token expired", status: 401 });
  return claims;
};

const errorResponse = (error: BlobError): Response =>
  Response.json({ error: { code: error.code, message: error.message, status: error.status } }, { status: error.status });

const asBlobError = (error: unknown): BlobError =>
  BlobError.is(error) ? error : new BlobError("request_failed", { message: error instanceof Error ? error.message : String(error), status: 500 });

const served = (constraints: RouteConstraints | undefined): ServedConstraints => ({
  ...(constraints?.contentTypes ? { contentTypes: expandContentTypes(constraints.contentTypes) } : {}),
  ...(constraints?.maxSize ? { maxSize: parseSize(constraints.maxSize, "maxSize") } : {}),
});

const checkFile = (constraints: RouteConstraints | undefined, file: UploadFile, head: Uint8Array | undefined): void => {
  const limits = served(constraints);
  if (limits.maxSize !== undefined && file.size > limits.maxSize) {
    throw new BlobError("too_large", { message: `${file.name} is ${file.size} bytes, over the ${limits.maxSize} byte limit`, status: 413 });
  }
  if (limits.contentTypes) checkContentType(file.type || "application/octet-stream", head, limits.contentTypes);
};

const threshold = (option: MultipartOption | undefined): number =>
  option === true ? 0 : option === false ? Number.POSITIVE_INFINITY : parseSize(option ?? DEFAULT_MULTIPART, "multipart");

const validate = async (schema: StandardSchema | undefined, value: unknown): Promise<unknown> => {
  if (!schema) return undefined;
  const result = await schema["~standard"].validate(value);
  if (result.issues?.length) throw new BlobError("invalid_input", { message: result.issues.map((issue) => issue.message).join("; ") });
  return result.value;
};

export const uploadHandler = <
  TRoutes extends Record<string, object>,
  TCtx = undefined,
  TData = void,
  TSchema extends StandardSchema | undefined = undefined,
>(
  options: UploadHandlerOptions<TCtx, TRoutes, TData, TSchema>,
): UploadHandler<HandlerRoutes<TRoutes, TData, OutputOf<TSchema>>, Awaited<TCtx>> => {
  const { routes, context, ...defaults } = options;
  const table = new Map<string, Mounted>();
  const named = Object.entries((routes ?? {}) as Record<string, AnyHooks | { [BUILT]: AnyHooks }>);
  if (named.length === 0) table.set("", { ...(defaults as AnyHooks), name: "" });
  for (const [name, route] of named) {
    const own: AnyHooks = BUILT in route ? route[BUILT] : route;
    const merged: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(own)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
    table.set(name, { ...(merged as AnyHooks), name });
  }

  const routeFor = (request: Request): Mounted => {
    const name = new URL(request.url).searchParams.get("route") ?? "";
    const route = table.get(name);
    if (!route) throw new BlobError("not_found", { message: "No such upload route", status: 404 });
    return route;
  };

  const bucketOf = (route: Mounted): Bucket => route.bucket ?? Bucket.fromEnv();

  const fail = async (route: Mounted | undefined, request: Request, ctx: unknown, error: unknown, extra: Partial<UploadErrorArgs> = {}): Promise<Response> => {
    const handled = route?.onError ? await route.onError({ ctx, route: route.name, request, error, ...extra }) : undefined;
    if (handled instanceof Response) return handled;
    return errorResponse(BlobError.is(handled) ? handled : asBlobError(error));
  };

  const plan = async (bucket: Bucket, sessionId: string, path: string, from: number): Promise<{ parts: WirePart[]; partSize: number; size: number; multipart: boolean; landed: { n: number; etag: string }[] }> => {
    const { client, baseUrl, wire } = internalsOf(bucket);
    const session = await client.json(uploadSessionSchema, `/v1/uploads/${encodeURIComponent(sessionId)}`);
    const size = session.expected_size_bytes ?? 0;
    const landed = session.uploaded_parts.map((part) => ({ n: part.part_number, etag: part.etag ?? "" }));
    if (session.upload_url) {
      return { parts: [{ n: 1, url: session.upload_url }], partSize: size, size, multipart: false, landed };
    }
    const to = Math.min(from + PART_BATCH - 1, session.total_parts);
    if (session.transport === "s3") {
      const urls = await client.json(partUrlsSchema, `/v1/uploads/${encodeURIComponent(sessionId)}/part-urls?from=${from}&to=${to}`);
      return { parts: urls.parts.map((part) => ({ n: part.part_number, url: part.url })), partSize: session.part_size, size, multipart: true, landed };
    }
    const token = await client.json(uploadTokenSchema, "/v1/upload-tokens", client.jsonInit("POST", { path: await wire(path), expires_in: "24h" }));
    const headers = { authorization: `Bearer ${token.token}` };
    const parts = Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => ({
      n: from + index,
      url: `${baseUrl}/v1/uploads/${encodeURIComponent(sessionId)}/parts/${from + index}`,
      headers,
    }));
    return { parts, partSize: session.part_size, size, multipart: true, landed };
  };

  const begin = async (request: Request, route: Mounted, ctx: unknown, body: Extract<WireRequest, { phase: "begin" }>): Promise<Response> => {
    const file = body.file;
    const head = body.head ? fromBase64(body.head) : undefined;
    checkFile(route.constraints, file, head);
    const input = await validate(route.input, body.input);
    const before = route.onBeforeUpload
      ? await route.onBeforeUpload({ ctx, route: route.name, request, file, input })
      : { path: uniquePath`${file.name}` };
    if (before.constraints) checkFile(before.constraints, file, head);
    const bucket = bucketOf(route);
    const { client, token, wire } = internalsOf(bucket);
    const multipart = file.size > threshold(route.multipart);
    const session = await client.json(uploadSessionSchema, "/v1/uploads", client.jsonInit("POST", {
      path: await wire(before.path),
      size_bytes: file.size,
      multipart,
      if_exists: "replace",
      content_type: file.type || undefined,
      cache: before.cache,
      metadata: before.metadata,
    }));
    const upload = await plan(bucket, session.id, before.path, 1);
    const claims: Claims = { u: session.id, p: before.path, r: route.name, f: file, m: before.metadata ?? {}, s: before.state ?? null, x: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
    const response: WireBeginResponse = {
      completionToken: await signClaims(token, claims),
      path: before.path,
      upload: { partSize: upload.partSize, parts: upload.parts, multipart: upload.multipart },
    };
    return Response.json(response);
  };

  const parts = async (route: Mounted, body: Extract<WireRequest, { phase: "parts" }>): Promise<Response> => {
    const bucket = bucketOf(route);
    const claims = await readClaims(internalsOf(bucket).token, body.completionToken);
    const response: WirePartsResponse = await plan(bucket, claims.u, claims.p, Math.max(1, body.from));
    return Response.json(response);
  };

  const end = async (request: Request, route: Mounted, ctx: unknown, body: Extract<WireRequest, { phase: "end" }>): Promise<Response> => {
    const bucket = bucketOf(route);
    const internals = internalsOf(bucket);
    const claims = await readClaims(internals.token, body.completionToken);
    const stored = await internals.client.complete(claims.u, undefined);
    const blob = await internals.completed(stored);
    const data = route.onUploadComplete
      ? await route.onUploadComplete({ ...blob, ctx, route: route.name, request, file: claims.f, uploadId: claims.u, metadata: claims.m, state: claims.s, multipartUploadId: claims.u })
      : undefined;
    const response: WireEndResponse = { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
    return Response.json(response);
  };

  const cancel = async (route: Mounted, body: Extract<WireRequest, { phase: "cancel" }>): Promise<Response> => {
    const internals = internalsOf(bucketOf(route));
    const claims = await readClaims(internals.token, body.completionToken);
    await internals.client.send(`/v1/uploads/${encodeURIComponent(claims.u)}`, { method: "DELETE" });
    return Response.json({});
  };

  const proxied = async (request: Request, route: Mounted, ctx: unknown): Promise<Response> => {
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
    const input = await validate(route.input, form ? JSON.parse(String(form.get("input") ?? "null")) : JSON.parse(decodeURIComponent(request.headers.get("x-upload-input") ?? "null")));
    const before = route.onBeforeUpload
      ? await route.onBeforeUpload({ ctx, route: route.name, request, file, input })
      : { path: uniquePath`${file.name}` };
    const limits = served(before.constraints ?? route.constraints);
    const bucket = bucketOf(route);
    const streamed = body instanceof File || declared !== null || limits.maxSize !== undefined ? body : await request.blob();
    const blob = await bucket.put(before.path, streamed, {
      contentType: file.type || "application/octet-stream",
      ...(body instanceof File || declared === null ? {} : { size: file.size }),
      ...(limits.maxSize === undefined ? {} : { maxSize: limits.maxSize }),
      ...(limits.contentTypes ? { contentTypes: limits.contentTypes } : {}),
      ...(before.cache ? { cache: before.cache } : {}),
      ...(before.metadata ? { metadata: before.metadata } : {}),
    });
    const data = route.onUploadComplete
      ? await route.onUploadComplete({ ...blob, ctx, route: route.name, request, file, uploadId: blob.etag, metadata: before.metadata ?? {}, state: before.state ?? null, multipartUploadId: undefined })
      : undefined;
    const response: WireEndResponse = { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
    return Response.json(response);
  };

  const GET = async (request: Request): Promise<Response> => {
    try {
      const route = routeFor(request);
      return Response.json({ constraints: served(route.constraints), proxy: route.proxy ?? false }, { headers: { "cache-control": "private, max-age=60" } });
    } catch (error) {
      return errorResponse(asBlobError(error));
    }
  };

  const POST = async (request: Request): Promise<Response> => {
    let route: Mounted | undefined;
    let ctx: unknown;
    try {
      route = routeFor(request);
      ctx = context ? await context(request) : undefined;
      if (route.proxy) return await proxied(request, route, ctx);
      const body: WireRequest = await request.json();
      if (body.phase === "begin") return await begin(request, route, ctx, body);
      if (body.phase === "parts") return await parts(route, body);
      if (body.phase === "end") return await end(request, route, ctx, body);
      if (body.phase === "cancel") return await cancel(route, body);
      throw new BlobError("invalid_input", { message: "expected a JSON body with a phase" });
    } catch (error) {
      return fail(route, request, ctx, error);
    }
  };

  return { GET, POST } as UploadHandler<HandlerRoutes<TRoutes, TData, OutputOf<TSchema>>, Awaited<TCtx>>;
};

export type AnyUploadHandler = UploadHandler<Record<string, UploadRouteDefinition<unknown, unknown>>, unknown>;
