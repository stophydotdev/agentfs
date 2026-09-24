export const abortError = (): Error =>
  typeof DOMException === "function"
    ? new DOMException("The upload was canceled", "AbortError")
    : Object.assign(new Error("The upload was canceled"), { name: "AbortError" });

export const isAbort = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

export const clock = {
  now: (): number => Date.now(),
  random: (): number => Math.random(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  timer: (ms: number, callback: () => void): (() => void) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  frame: (callback: () => void): void => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
    else setTimeout(callback, 16);
  },
};
