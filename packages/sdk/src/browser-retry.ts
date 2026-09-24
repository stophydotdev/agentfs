import { clock } from "./browser-clock";

export const MAX_ATTEMPTS = 8;
export const MAX_NETWORK_ATTEMPTS = 20;
export const NO_BYTES_NETWORK_ATTEMPTS = 3;
export const STALL_TIMEOUT_MS = 60_000;
const BASE_MS = 500;
const CAP_MS = 15_000;
const RETRY_AFTER_CAP_MS = 60_000;

export type Verdict = "retry" | "represign" | "fail";

export const classify = (status: number): Verdict => {
  if (status === 0 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return "retry";
  if (status === 401 || status === 403) return "represign";
  return "fail";
};

export const backoffMs = (attempt: number, retryAfter?: string | null): number => {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - clock.now(), RETRY_AFTER_CAP_MS));
  }
  return Math.floor(clock.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt));
};
