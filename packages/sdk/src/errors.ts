import { problemSchema } from "./schemas";

export type BlobErrorCode =
  | "not_found"
  | "already_exists"
  | "conflict"
  | "content_type_not_allowed"
  | "invalid_input"
  | "too_large"
  | "empty_body"
  | "length_required"
  | "signature_mismatch"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "mint_backoff"
  | "not_ready"
  | "partial_delete"
  | "move_left_a_copy"
  | "invalid_content_type_pattern"
  | "request_failed";

const FROM_API: Record<string, BlobErrorCode> = {
  file_not_found: "not_found",
  not_found: "not_found",
  project_not_found: "not_found",
  upload_not_found: "not_found",
  path_exists: "already_exists",
  precondition_failed: "conflict",
  idempotency_conflict: "conflict",
  content_type_not_allowed: "content_type_not_allowed",
  file_too_large: "too_large",
  storage_limit_exceeded: "too_large",
  length_required: "length_required",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  visibility_forbidden: "forbidden",
  rate_limited: "rate_limited",
  upload_rate_limited: "rate_limited",
  quota_exceeded: "rate_limited",
  invalid_path: "invalid_input",
  invalid_metadata: "invalid_input",
  invalid_upload: "invalid_input",
  invalid_query: "invalid_input",
  invalid_expiration: "invalid_input",
  visibility_mismatch: "invalid_input",
  object_not_ready: "not_ready",
  upload_not_active: "not_ready",
  upload_still_completing: "not_ready",
  upload_unavailable: "not_ready",
  empty_body: "empty_body",
  SignatureDoesNotMatch: "signature_mismatch",
  AccessDenied: "forbidden",
  NoSuchKey: "not_found",
  NoSuchUpload: "not_found",
};

export const STATUS: Record<BlobErrorCode, number> = {
  not_found: 404,
  already_exists: 409,
  conflict: 409,
  content_type_not_allowed: 400,
  invalid_input: 400,
  too_large: 413,
  empty_body: 400,
  length_required: 411,
  signature_mismatch: 403,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  mint_backoff: 429,
  not_ready: 503,
  partial_delete: 500,
  move_left_a_copy: 500,
  invalid_content_type_pattern: 500,
  request_failed: 500,
};

const DEFAULT_MESSAGE: Record<BlobErrorCode, string> = {
  not_found: "not found",
  already_exists: "already exists",
  conflict: "the object changed since it was read",
  content_type_not_allowed: "content type not allowed",
  invalid_input: "invalid input",
  too_large: "too large",
  empty_body: "empty body",
  length_required: "length required",
  signature_mismatch: "signature mismatch",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  rate_limited: "rate limited",
  mint_backoff: "the credential service asked for a backoff longer than a request can wait",
  not_ready: "not ready",
  partial_delete: "some paths were not deleted",
  move_left_a_copy: "move left a copy at the source",
  invalid_content_type_pattern: "invalid content type pattern",
  request_failed: "request failed",
};

const DEFAULT_HINT: Partial<Record<BlobErrorCode, string>> = {
  signature_mismatch: "a 403 from R2 usually means the body length or type differs from the signature",
  length_required: "pass { size } or { maxSize } so the length is known before the first byte",
};

const CODE_FOR_STATUS: Partial<Record<number, BlobErrorCode>> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  411: "length_required",
  413: "too_large",
  429: "rate_limited",
};

export interface BlobErrorOptions {
  readonly message?: string;
  readonly hint?: string;
  readonly status?: number;
  readonly failed?: string[];
  readonly etag?: string;
  readonly size?: number;
  readonly retryAfter?: number;
  readonly cause?: unknown;
  readonly apiCode?: string;
  readonly retryable?: boolean;
}

export interface BlobErrorJSON {
  code: BlobErrorCode;
  message: string;
  status: number;
  hint?: string;
  failed?: string[];
  etag?: string;
  size?: number;
  retryAfter?: number;
}

const MARK = Symbol.for("@agentfs/sdk/BlobError");
const OPENS_WITH_IDENTIFIER = /^[a-z][\w+*-]*[./][\w.+*/-]*/;

const sentenceCase = (message: string): string =>
  OPENS_WITH_IDENTIFIER.test(message) ? message : message.charAt(0).toUpperCase() + message.slice(1);

const isCode = (value: unknown): value is BlobErrorCode => typeof value === "string" && value in STATUS;

export class BlobError extends Error {
  override readonly name = "BlobError";
  readonly code: BlobErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly failed: string[] | undefined;
  readonly etag: string | undefined;
  readonly size: number | undefined;
  readonly retryAfter: number | undefined;
  readonly apiCode: string | undefined;
  readonly retryable: boolean;
  readonly [MARK] = true;

  constructor(code: BlobErrorCode, options: BlobErrorOptions | string = {}) {
    const resolved: BlobErrorOptions = typeof options === "string" ? { message: options } : options;
    const raw = resolved.message ?? DEFAULT_MESSAGE[code];
    const hint = resolved.hint ?? DEFAULT_HINT[code];
    const base = sentenceCase(raw);
    super(hint && !raw.includes(hint) ? `${base} (${hint})` : base, resolved.cause === undefined ? undefined : { cause: resolved.cause });
    this.code = code;
    this.status = resolved.status ?? STATUS[code];
    this.hint = hint;
    this.failed = resolved.failed;
    this.etag = resolved.etag;
    this.size = resolved.size;
    this.retryAfter = resolved.retryAfter;
    this.apiCode = resolved.apiCode;
    this.retryable = resolved.retryable ?? false;
  }

  static fromStatus(status: number, options: BlobErrorOptions = {}): BlobError {
    return new BlobError(CODE_FOR_STATUS[status] ?? "request_failed", { ...options, status });
  }

  static is(error: unknown): error is BlobError {
    return typeof error === "object" && error !== null && MARK in error;
  }

  toJSON(): BlobErrorJSON {
    const json: BlobErrorJSON = { code: this.code, message: this.message, status: this.status };
    if (this.hint) json.hint = this.hint;
    if (this.failed) json.failed = this.failed;
    if (this.etag) json.etag = this.etag;
    if (this.size !== undefined) json.size = this.size;
    if (this.retryAfter !== undefined) json.retryAfter = this.retryAfter;
    return json;
  }

  static fromJSON(body: unknown, status?: number): BlobError | undefined {
    if (typeof body !== "object" || body === null || !("code" in body) || !isCode(body.code)) return undefined;
    const field = <T>(key: string, check: (value: unknown) => value is T): T | undefined => {
      const value: unknown = (body as Record<string, unknown>)[key];
      return check(value) ? value : undefined;
    };
    const isString = (value: unknown): value is string => typeof value === "string";
    const isNumber = (value: unknown): value is number => typeof value === "number";
    const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
    const options: { -readonly [K in keyof BlobErrorOptions]: BlobErrorOptions[K] } = {};
    const message = field("message", isString);
    const hint = field("hint", isString);
    const failed = field("failed", isStrings);
    const etag = field("etag", isString);
    const size = field("size", isNumber);
    const retryAfter = field("retryAfter", isNumber);
    const statusValue = status ?? field("status", isNumber);
    if (message !== undefined) options.message = message;
    if (hint !== undefined) options.hint = hint;
    if (failed !== undefined) options.failed = failed;
    if (etag !== undefined) options.etag = etag;
    if (size !== undefined) options.size = size;
    if (retryAfter !== undefined) options.retryAfter = retryAfter;
    if (statusValue !== undefined) options.status = statusValue;
    return new BlobError(body.code, options);
  }
}

export const retryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const STATUS_FALLBACK: Partial<Record<number, BlobErrorCode>> = {
  401: "unauthorized",
  404: "not_found",
  412: "conflict",
  413: "too_large",
  429: "rate_limited",
  503: "not_ready",
};

const KEEPS_DETAIL = new Set<BlobErrorCode>(["invalid_input", "forbidden", "content_type_not_allowed", "already_exists", "request_failed"]);

export const errorFromResponse = async (response: Response, fallback: string): Promise<BlobError> => {
  const text = await response.text().catch(() => "");
  const problem = problemSchema.safeParse(parseJson(text));
  const apiCode = problem.success ? problem.data.code ?? problem.data.title : /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  const known = apiCode === undefined ? undefined : FROM_API[apiCode];
  const code = known ?? STATUS_FALLBACK[response.status] ?? "request_failed";
  const detail = (problem.success && problem.data.detail) || /<Message>([^<]*)<\/Message>/.exec(text)?.[1] || fallback;
  const retryable = problem.success && problem.data.retryable !== undefined ? problem.data.retryable : retryableStatus(response.status);
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  return new BlobError(code, {
    ...(KEEPS_DETAIL.has(code) ? { message: code === "request_failed" ? `request failed with ${response.status}: ${detail}` : detail } : {}),
    ...(code === "request_failed" ? { status: response.status >= 500 ? 502 : response.status } : {}),
    retryable,
    ...(apiCode === undefined ? {} : { apiCode }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
};
