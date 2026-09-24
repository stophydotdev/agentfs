import { BlobError } from "./errors";

export type RetryPolicy = {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
};

export const defaultRetryPolicy: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  random: Math.random,
};

const RETRY_AFTER_MAX_MS = 10_000;

export class ExpiredUrlError extends Error {
  override readonly name = "ExpiredUrlError";
}

export const withRetry = async <T>(task: () => Promise<T>, policy: RetryPolicy, signal?: AbortSignal | null): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await task();
    } catch (error) {
      if (signal?.aborted || attempt >= policy.attempts) throw error;
      if (error instanceof ExpiredUrlError) continue;
      if (error instanceof BlobError ? !error.retryable : !(error instanceof TypeError)) throw error;
      const retryAfter = error instanceof BlobError ? error.retryAfter : undefined;
      await policy.sleep(retryAfter === undefined
        ? Math.floor(policy.random() * Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt))
        : Math.min(retryAfter * 1000, RETRY_AFTER_MAX_MS));
    }
  }
};
