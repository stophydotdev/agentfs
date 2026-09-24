import { abortError } from "./browser-clock";

export const GLOBAL_REQUEST_CAP = 6;

interface Waiter {
  grant: () => void;
  signal: AbortSignal | undefined;
}

let active = 0;
const waiting: Waiter[] = [];

const pump = (): void => {
  while (active < GLOBAL_REQUEST_CAP) {
    const next = waiting.shift();
    if (!next) return;
    if (next.signal?.aborted) continue;
    active += 1;
    next.grant();
  }
};

export const acquire = (signal?: AbortSignal): Promise<() => void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      pump();
    };
    const onAbort = () => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(abortError());
    };
    const entry: Waiter = {
      signal,
      grant: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(entry);
    pump();
  });

export const poolState = (): { active: number; waiting: number } => ({ active, waiting: waiting.length });
