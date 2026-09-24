import { abortError, clock, isAbort } from "./browser-clock";

export interface XhrRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: XMLHttpRequestBodyInit | null;
  signal?: AbortSignal;
  onUploadProgress?: (loaded: number, total: number) => void;
  onUploadDone?: () => void;
  stallTimeoutMs?: number;
}

export interface XhrResponse {
  status: number;
  statusText: string;
  header(name: string): string | null;
  text: string;
}

export class NetworkError extends Error {
  override readonly name = "NetworkError";
}

const stallError = (ms: number): NetworkError => new NetworkError(`no progress for ${Math.round(ms / 1000)}s`);

export const sendXhr = (request: XhrRequest): Promise<XhrResponse> =>
  typeof XMLHttpRequest === "undefined" ? sendFetch(request) : sendRequest(request);

const sendRequest = (request: XhrRequest): Promise<XhrResponse> =>
  new Promise((resolve, reject) => {
    if (request.signal?.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url, true);
    for (const [name, value] of Object.entries(request.headers ?? {})) xhr.setRequestHeader(name, value);
    let cancelStall = () => {};
    const cleanup = () => {
      cancelStall();
      request.signal?.removeEventListener("abort", onAbort);
    };
    const arm = () => {
      const ms = request.stallTimeoutMs;
      if (!ms) return;
      cancelStall();
      cancelStall = clock.timer(ms, () => {
        cleanup();
        reject(stallError(ms));
        xhr.abort();
      });
    };
    const onAbort = () => {
      xhr.abort();
      cleanup();
      reject(abortError());
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    xhr.upload.onprogress = (event) => {
      arm();
      request.onUploadProgress?.(event.loaded, event.lengthComputable ? event.total : event.loaded);
    };
    xhr.upload.onload = () => {
      arm();
      request.onUploadDone?.();
    };
    xhr.onload = () => {
      cleanup();
      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        header: (name) => {
          try {
            return xhr.getResponseHeader(name);
          } catch {
            return null;
          }
        },
        text: xhr.responseText,
      });
    };
    xhr.onerror = () => {
      cleanup();
      reject(new NetworkError("network error"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new NetworkError("timeout"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(abortError());
    };
    arm();
    xhr.send(request.body ?? null);
  });

const sendFetch = async (request: XhrRequest): Promise<XhrResponse> => {
  if (request.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const ms = request.stallTimeoutMs;
  let stalled = false;
  const cancelStall = ms
    ? clock.timer(ms, () => {
        stalled = true;
        controller.abort();
      })
    : () => {};
  try {
    const response = await fetch(request.url, {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body ? { body: request.body } : {}),
      signal: controller.signal,
    });
    request.onUploadDone?.();
    const text = await response.text();
    return { status: response.status, statusText: response.statusText, header: (name) => response.headers.get(name), text };
  } catch (error) {
    if (stalled && ms) throw stallError(ms);
    if (request.signal?.aborted || isAbort(error)) throw abortError();
    throw new NetworkError(error instanceof Error ? error.message : "network error");
  } finally {
    cancelStall();
    request.signal?.removeEventListener("abort", onAbort);
  }
};
