import { BlobError } from "./errors";

export type RetryPolicy = {
  readonly httpAttempts: number;
  readonly networkAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
};

export const defaultRetryPolicy: RetryPolicy = {
  httpAttempts: 8,
  networkAttempts: 20,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  random: Math.random,
};

export class ExpiredUrlError extends Error {
  override readonly name = "ExpiredUrlError";
}

export const withRetry = async <T>(task: () => Promise<T>, policy: RetryPolicy, signal?: AbortSignal): Promise<T> => {
  let httpFailures = 0;
  let networkFailures = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await task();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof BlobError && !error.retryable) throw error;
      if (error instanceof ExpiredUrlError) {
        httpFailures += 1;
        if (httpFailures >= policy.httpAttempts) throw error;
        continue;
      }
      if (error instanceof BlobError) httpFailures += 1;
      else if (error instanceof TypeError) networkFailures += 1;
      else throw error;
      if (httpFailures >= policy.httpAttempts || networkFailures >= policy.networkAttempts) throw error;
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (httpFailures + networkFailures - 1));
      const retryAfter = error instanceof BlobError ? error.retryAfterSeconds : undefined;
      await policy.sleep(retryAfter === undefined ? policy.random() * ceiling : retryAfter * 1000);
    }
  }
};
