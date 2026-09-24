import { BlobError, type BlobErrorCode } from "./errors";
import { SNIFF_BYTES } from "./sniff";
import {
  toBase64,
  type UploadedBlob,
  type UploadSnapshot,
  type UploadTask,
  type WireBeginResponse,
  type WireEndResponse,
  type WireError,
  type WirePart,
  type WirePartsResponse,
  type WireRequest,
} from "./wire";

export { BlobError } from "./errors";
export type { BlobErrorCode } from "./errors";
export { formatBytes, type Size } from "./units";
export type { UploadedBlob, UploadSnapshot, UploadTask } from "./wire";

export type HeadersProvider = () => Record<string, string> | Promise<Record<string, string>>;

export interface UploadOptions<TInput = unknown> {
  route: string;
  headers?: HeadersProvider;
  input?: TInput;
  sniffBytes?: boolean;
  concurrency?: number;
}

type Status = UploadSnapshot["status"];
type Done = UploadedBlob & { data: unknown };

const PART_ATTEMPTS = 3;
const STORAGE_PREFIX = "agentfs-upload:";

const isBlobCode = (code: string): code is BlobErrorCode =>
  ["not_found", "already_exists", "conflict", "content_type_not_allowed", "invalid_input", "too_large", "empty_body", "length_required",
    "signature_mismatch", "unauthorized", "forbidden", "rate_limited", "mint_backoff", "not_ready", "partial_delete", "move_left_a_copy",
    "invalid_content_type_pattern", "request_failed"].includes(code);

const routeError = async (response: Response): Promise<BlobError> => {
  const body: Partial<WireError> = await response.json().catch(() => ({}));
  const code = body.error?.code ?? "";
  return new BlobError(isBlobCode(code) ? code : "request_failed", {
    message: body.error?.message ?? `The upload route answered ${response.status}`,
    status: response.status,
    retryable: response.status >= 500 || response.status === 429,
  });
};

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

interface Transfer {
  readonly done: Promise<void>;
  readonly abort: () => void;
}

const send = (url: string, body: Blob, headers: Record<string, string> | undefined, onProgress: (loaded: number) => void): Transfer => {
  if (typeof XMLHttpRequest === "undefined") {
    const controller = new AbortController();
    const done = fetch(url, { method: "PUT", body, ...(headers ? { headers } : {}), signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw await routeError(response);
      onProgress(body.size);
    });
    return { done, abort: () => controller.abort() };
  }
  const request = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers ?? {})) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => (request.status >= 200 && request.status < 300
      ? resolve()
      : reject(new BlobError(request.status === 403 ? "signature_mismatch" : "request_failed", { message: `Storage answered ${request.status}`, status: request.status, retryable: true })));
    request.onerror = () => reject(new BlobError("request_failed", { message: "The network dropped the part", status: 0, retryable: true }));
    request.onabort = () => reject(new BlobError("request_failed", { message: "aborted", status: 499 }));
    request.send(body);
  });
  return { done, abort: () => request.abort() };
};

export const upload = <TInput = unknown>(file: File, options: UploadOptions<TInput>): UploadTask => {
  const listeners = new Set<() => void>();
  const inFlight = new Map<number, Transfer>();
  const progress = new Map<number, number>();
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const storageKey = `${STORAGE_PREFIX}${options.route}:${file.name}:${file.size}:${file.lastModified}`;
  let status: Status = "queued";
  let blob: Done | undefined;
  let error: BlobError | undefined;
  let completionToken: string | undefined;
  let running: Promise<void> | undefined;
  let finish: (value: Done) => void = () => undefined;
  let reject: (reason: BlobError) => void = () => undefined;
  const done = new Promise<Done>((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  done.catch(() => undefined);

  const stopped = (): boolean => status === "paused" || status === "canceled";
  const loaded = (): number => [...progress.values()].reduce((sum, bytes) => sum + bytes, 0);
  const notify = () => listeners.forEach((listener) => listener());
  const set = (next: Status) => {
    status = next;
    notify();
  };

  const post = async <T>(body: WireRequest): Promise<T> => {
    const headers = { "content-type": "application/json", ...(await options.headers?.()) };
    const response = await fetch(options.route, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) throw await routeError(response);
    return response.json();
  };

  const begin = async (): Promise<WireBeginResponse> => {
    const head = options.sniffBytes === false ? undefined : toBase64(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
    return post<WireBeginResponse>({
      phase: "begin",
      file: { name: file.name, type: file.type, size: file.size },
      ...(head ? { head } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  };

  const sendPart = async (part: WirePart, partSize: number, multipart: boolean, refresh: (n: number) => Promise<WirePart>): Promise<void> => {
    const bytes = multipart ? file.slice((part.n - 1) * partSize, part.n * partSize) : file;
    let current = part;
    for (let attempt = 1; ; attempt += 1) {
      if (stopped()) return;
      const transfer = send(current.url, bytes, current.headers, (sent) => {
        progress.set(part.n, sent);
        notify();
      });
      inFlight.set(part.n, transfer);
      try {
        await transfer.done;
        progress.set(part.n, bytes.size);
        inFlight.delete(part.n);
        notify();
        return;
      } catch (caught) {
        inFlight.delete(part.n);
        progress.set(part.n, 0);
        if (stopped()) return;
        const failure = BlobError.is(caught) ? caught : new BlobError("request_failed", { message: String(caught), status: 0 });
        if (attempt >= PART_ATTEMPTS || !failure.retryable) throw failure;
        if (failure.code === "signature_mismatch") current = await refresh(part.n);
      }
    }
  };

  const run = async (): Promise<void> => {
    set("uploading");
    const saved = storage()?.getItem(storageKey) ?? undefined;
    const resumed = saved
      ? await post<WirePartsResponse>({ phase: "parts", completionToken: saved, from: 1 }).catch(() => {
          storage()?.removeItem(storageKey);
          return undefined;
        })
      : undefined;
    if (resumed) completionToken = saved;
    const plan: WirePartsResponse = resumed ?? await (async () => {
      const started = await begin();
      completionToken = started.completionToken;
      if (started.upload.multipart) storage()?.setItem(storageKey, completionToken);
      return { ...started.upload, size: file.size, landed: [] };
    })();
    const token = completionToken ?? "";
    const urls = new Map(plan.parts.map((part) => [part.n, part]));
    const totalParts = plan.multipart ? Math.max(1, Math.ceil(file.size / plan.partSize)) : 1;
    for (const landed of plan.landed) progress.set(landed.n, Math.min(plan.partSize, file.size - (landed.n - 1) * plan.partSize));
    const waiting = Array.from({ length: totalParts }, (_, index) => index + 1).filter((n) => !plan.landed.some((landed) => landed.n === n));
    const partFor = async (n: number, fresh = false): Promise<WirePart> => {
      const known = urls.get(n);
      if (known && !fresh) return known;
      const more = await post<WirePartsResponse>({ phase: "parts", completionToken: token, from: n });
      for (const part of more.parts) urls.set(part.n, part);
      const found = urls.get(n);
      if (!found) throw new BlobError("request_failed", { message: `No upload URL for part ${n}`, status: 502 });
      return found;
    };
    let next = 0;
    const worker = async () => {
      while (next < waiting.length && status === "uploading") {
        const n = waiting[next++];
        if (n === undefined) return;
        await sendPart(await partFor(n), plan.partSize, plan.multipart, (part) => partFor(part, true));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, waiting.length) }, worker));
    if (status !== "uploading") return;
    set("finishing");
    const ended = await post<WireEndResponse>({ phase: "end", completionToken: token });
    storage()?.removeItem(storageKey);
    blob = { ...ended.blob, uploadedAt: new Date(ended.blob.uploadedAt), data: ended.data };
    set("done");
    finish(blob);
  };

  const start = () => {
    running = run().catch((caught: unknown) => {
      if (stopped()) return;
      error = BlobError.is(caught) ? caught : new BlobError("request_failed", { message: String(caught), status: 0 });
      set("error");
      reject(error);
    });
  };

  const task: UploadTask = {
    id: crypto.randomUUID(),
    file,
    snapshot: () => {
      const base = {
        loaded: loaded(),
        total: file.size,
        percent: status === "done" ? 100 : Math.min(99, file.size ? Math.floor((loaded() / file.size) * 100) : 0),
        canPause: status === "uploading" && file.size > 0,
        pending: status === "queued" || status === "uploading" || status === "finishing" || status === "paused",
        stalled: false,
      };
      if (status === "done" && blob) return { ...base, status, blob };
      if (status === "error" && error) return { ...base, status, error };
      if (status === "canceled") return { ...base, status };
      return { ...base, status: status === "done" || status === "error" ? "uploading" : status };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    done,
    pause: () => {
      if (status !== "uploading") return false;
      set("paused");
      for (const transfer of inFlight.values()) transfer.abort();
      return true;
    },
    resume: () => {
      if (status !== "paused") return false;
      void running?.then(start);
      return true;
    },
    cancel: () => {
      if (status === "done" || status === "canceled") return false;
      set("canceled");
      for (const transfer of inFlight.values()) transfer.abort();
      storage()?.removeItem(storageKey);
      if (completionToken) void post({ phase: "cancel", completionToken }).catch(() => undefined);
      reject(new BlobError("request_failed", { message: "The upload was canceled", status: 499 }));
      return true;
    },
    retry: () => {
      if (status !== "error") return false;
      error = undefined;
      start();
      return true;
    },
  };
  start();
  return task;
};

export const uploadThroughServer = (file: File, options: UploadOptions): UploadTask => {
  const listeners = new Set<() => void>();
  let status: Status = "uploading";
  let sent = 0;
  let blob: Done | undefined;
  let error: BlobError | undefined;
  let abort: () => void = () => undefined;
  const notify = () => listeners.forEach((listener) => listener());
  const done = (async (): Promise<Done> => {
    const headers: Record<string, string> = {
      "content-type": file.type || "application/octet-stream",
      "x-upload-name": encodeURIComponent(file.name),
      ...(options.input === undefined ? {} : { "x-upload-input": encodeURIComponent(JSON.stringify(options.input)) }),
      ...(await options.headers?.()),
    };
    const controller = new AbortController();
    abort = () => controller.abort();
    const response = await fetch(options.route, { method: "POST", headers, body: file, signal: controller.signal });
    if (!response.ok) throw await routeError(response);
    const ended: WireEndResponse = await response.json();
    sent = file.size;
    blob = { ...ended.blob, uploadedAt: new Date(ended.blob.uploadedAt), data: ended.data };
    status = "done";
    notify();
    return blob;
  })();
  done.catch((caught: unknown) => {
    if (status === "canceled") return;
    error = BlobError.is(caught) ? caught : new BlobError("request_failed", { message: String(caught), status: 0 });
    status = "error";
    notify();
  });
  return {
    id: crypto.randomUUID(),
    file,
    snapshot: () => {
      const base = { loaded: sent, total: file.size, percent: status === "done" ? 100 : 0, canPause: false, pending: status === "uploading", stalled: false };
      if (status === "done" && blob) return { ...base, status, blob };
      if (status === "error" && error) return { ...base, status, error };
      if (status === "canceled") return { ...base, status };
      return { ...base, status: "uploading" };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    done,
    pause: () => false,
    resume: () => false,
    cancel: () => {
      if (status !== "uploading") return false;
      status = "canceled";
      abort();
      notify();
      return true;
    },
    retry: () => false,
  };
};
