import { problemSchema } from "./schemas";

export class AgentFSError extends Error {
  override readonly name = "AgentFSError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
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

export const errorFromResponse = async (response: Response, fallback: string): Promise<AgentFSError> => {
  const text = await response.text().catch(() => "");
  const problem = problemSchema.safeParse(parseJson(text));
  const xmlMessage = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  const code = (problem.success && (problem.data.code ?? problem.data.title)) || `http_${response.status}`;
  const detail = (problem.success && problem.data.detail) || xmlMessage || fallback;
  const retryable = problem.success && problem.data.retryable !== undefined ? problem.data.retryable : retryableStatus(response.status);
  return new AgentFSError(response.status, code, detail, retryable, parseRetryAfter(response.headers.get("retry-after")));
};
