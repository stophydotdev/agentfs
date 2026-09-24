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
  upload_unavailable: "mint_backoff",
  empty_body: "empty_body",
  SignatureDoesNotMatch: "signature_mismatch",
  AccessDenied: "forbidden",
  NoSuchKey: "not_found",
  NoSuchUpload: "not_found",
};

export interface BlobErrorOptions {
  readonly message?: string;
  readonly status?: number;
  readonly apiCode?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
}

export class BlobError extends Error {
  override readonly name = "BlobError";
  readonly status: number;
  readonly apiCode: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(readonly code: BlobErrorCode, options: BlobErrorOptions = {}) {
    super(options.message ?? code.replaceAll("_", " "));
    this.status = options.status ?? 400;
    this.apiCode = options.apiCode;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  static is(error: unknown): error is BlobError {
    return error instanceof BlobError;
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

export const errorFromResponse = async (response: Response, fallback: string): Promise<BlobError> => {
  const text = await response.text().catch(() => "");
  const problem = problemSchema.safeParse(parseJson(text));
  const apiCode = problem.success ? problem.data.code ?? problem.data.title : /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  const known = apiCode === undefined ? undefined : FROM_API[apiCode];
  const code = known ?? (response.status === 404 ? "not_found" : "request_failed");
  const message = (problem.success && problem.data.detail) || /<Message>([^<]*)<\/Message>/.exec(text)?.[1] || fallback;
  const retryable = problem.success && problem.data.retryable !== undefined ? problem.data.retryable : retryableStatus(response.status);
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  return new BlobError(code, {
    message,
    status: response.status,
    retryable,
    ...(apiCode === undefined ? {} : { apiCode }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
};
