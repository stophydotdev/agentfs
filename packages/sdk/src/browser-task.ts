import { BlobError } from "./errors";
import { SNIFF_BYTES } from "./sniff";
import { abortError, clock, isAbort } from "./browser-clock";
import { acquire } from "./browser-pool";
import { backoffMs, classify, MAX_ATTEMPTS, MAX_NETWORK_ATTEMPTS, NO_BYTES_NETWORK_ATTEMPTS, STALL_TIMEOUT_MS } from "./browser-retry";
import { clearPending, fingerprint, readPending, writePending } from "./browser-store";
import { NetworkError, sendXhr } from "./browser-xhr";
import type {
  UploadedBlob,
  UploadSnapshot,
  UploadTask,
  WireBeginResponse,
  WireEndResponse,
  WireLanded,
  WirePart,
  WirePartsResponse,
  WireRequest,
} from "./wire";

export type HeadersProvider = () => Record<string, string> | Promise<Record<string, string>>;

export interface UploadOptions<TInput = unknown> {
  route: string;
  headers?: HeadersProvider;
  input?: TInput;
  sniffBytes?: boolean;
}

export interface InternalTask extends UploadTask {
  start(): void;
}

export type Done = UploadedBlob & { data: unknown };

interface RouteResponses {
  begin: WireBeginResponse;
  parts: WirePartsResponse;
  end: WireEndResponse;
  cancel: unknown;
}

type Phase = WireRequest["phase"];

const PARTS_IN_FLIGHT = 4;
const ROUTE_ATTEMPTS = 3;
const PRESIGN_STALE_MS = 60_000;
const MAX_URL_BATCHES = 4;

export const CORS_HINT =
  "the browser blocked the request before sending any bytes, which is almost always CORS: the bucket has to allow PUT and the signed headers from this origin";

type Status = UploadSnapshot["status"];

interface PartState {
  n: number;
  size: number;
  etag?: string;
}

interface Signed {
  url: string;
  headers: Record<string, string>;
}

interface InFlight {
  loaded: number;
  backingOff: boolean;
  controller: AbortController;
}

let counter = 0;

export const createTask = (file: File, options: UploadOptions, autoStart: boolean): InternalTask => {
  const task = new Task(file, options);
  if (autoStart) task.start();
  return task;
};

class Task implements InternalTask {
  readonly id = `u${++counter}-${clock.now().toString(36)}`;

  private status: Status = "queued";
  private error: BlobError | undefined;
  private blob: Done | undefined;
  private token: string | undefined;
  private readonly storeKey: string;
  private partSize = 0;
  private multipart = false;
  private readonly parts = new Map<number, PartState>();
  private readonly urls = new Map<number, Signed>();
  private batch: Promise<void> | undefined;
  private readonly inflight = new Map<number, InFlight>();
  private readonly represigned = new Set<number>();
  private urlsMintedAt = 0;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private readonly cancelController = new AbortController();
  private started = false;
  private readonly listeners = new Set<() => void>();
  private cached: UploadSnapshot | undefined;
  private frameQueued = false;
  private resolveDone: (blob: Done) => void = () => {};
  private rejectDone: (error: unknown) => void = () => {};
  private donePromise: Promise<Done>;

  constructor(
    readonly file: File,
    private readonly options: UploadOptions,
  ) {
    this.storeKey = fingerprint(options.route, file);
    this.donePromise = this.freshDone();
  }

  get done(): Promise<Done> {
    return this.donePromise;
  }

  private freshDone(): Promise<Done> {
    const promise = new Promise<Done>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    promise.catch(() => {});
    return promise;
  }

  snapshot(): UploadSnapshot {
    if (this.cached) return this.cached;
    const total = this.file.size;
    let loaded = 0;
    for (const part of this.parts.values()) if (part.etag !== undefined) loaded += part.size;
    for (const flight of this.inflight.values()) loaded += flight.loaded;
    const done = this.status === "done";
    if (done) loaded = total;
    const base = {
      loaded,
      total,
      percent: done ? 100 : total > 0 ? Math.min(99, Math.floor((loaded / total) * 100)) : 0,
      canPause: this.multipart && (this.status === "queued" || this.status === "uploading" || this.status === "paused"),
      pending: this.status !== "done" && this.status !== "error" && this.status !== "canceled",
      stalled: this.inflight.size > 0 && [...this.inflight.values()].every((flight) => flight.backingOff),
    };
    if (this.status === "done" && this.blob) this.cached = { ...base, status: "done", blob: this.blob };
    else if (this.status === "error" && this.error) this.cached = { ...base, status: "error", error: this.error };
    else if (this.status === "canceled") this.cached = { ...base, status: "canceled" };
    else this.cached = { ...base, status: this.status === "done" || this.status === "error" ? "finishing" : this.status };
    return this.cached;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  private notify(): void {
    this.cached = undefined;
    if (this.frameQueued) return;
    this.frameQueued = true;
    clock.frame(() => {
      this.frameQueued = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  pause(): boolean {
    if (!this.multipart || this.status !== "uploading" || this.paused) return false;
    this.paused = true;
    this.status = "paused";
    for (const flight of this.inflight.values()) if (flight.loaded === 0) flight.controller.abort();
    this.notify();
    return true;
  }

  resume(): boolean {
    if (this.status !== "paused") return false;
    this.paused = false;
    this.status = "uploading";
    this.wake();
    this.notify();
    return true;
  }

  retry(): boolean {
    if (this.status !== "error") return false;
    this.error = undefined;
    this.status = "queued";
    this.inflight.clear();
    this.represigned.clear();
    this.donePromise = this.freshDone();
    this.started = false;
    this.notify();
    this.start();
    return true;
  }

  cancel(): boolean {
    if (this.status === "done" || this.status === "error" || this.status === "canceled") return false;
    const finishing = this.status === "finishing";
    this.status = "canceled";
    this.paused = false;
    this.cancelController.abort();
    for (const flight of this.inflight.values()) flight.controller.abort();
    this.wake();
    if (finishing) clearPending(this.storeKey);
    else this.abortServerSide();
    this.inflight.clear();
    this.notify();
    this.rejectDone(abortError());
    return true;
  }

  private wake(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private abortServerSide(): void {
    clearPending(this.storeKey);
    const token = this.token;
    if (!token) return;
    this.token = undefined;
    this.routeCall({ phase: "cancel", completionToken: token }, undefined, 1).catch(() => {});
  }

  private landed(): WireLanded[] {
    return [...this.parts.values()].flatMap((part) => (part.etag === undefined ? [] : [{ n: part.n, etag: part.etag }]));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.run().then(
      (blob) => {
        if (this.status === "canceled") return;
        this.blob = blob;
        this.status = "done";
        clearPending(this.storeKey);
        this.notify();
        this.resolveDone(blob);
      },
      (error: unknown) => {
        if (this.status === "canceled" || isAbort(error)) return;
        this.error = BlobError.is(error)
          ? error
          : new BlobError("request_failed", { message: error instanceof Error ? error.message : String(error), status: 503, cause: error });
        this.status = "error";
        this.inflight.clear();
        this.notify();
        this.rejectDone(this.error);
      },
    );
  }

  private async run(): Promise<Done> {
    const signal = this.cancelController.signal;
    if (this.token) {
      this.urls.clear();
      await this.fetchBatch(this.firstMissing());
    } else if (!(await this.tryResume())) {
      await this.begin();
    }
    if (signal.aborted) {
      this.abortServerSide();
      throw abortError();
    }
    this.status = "uploading";
    this.notify();

    await this.runParts();
    const parts = this.landed();
    if (signal.aborted) throw abortError();

    this.status = "finishing";
    this.notify();
    const end = await this.routeCall({ phase: "end", completionToken: this.requireToken(), parts }, signal);
    return { ...end.blob, uploadedAt: new Date(end.blob.uploadedAt), data: end.data };
  }

  private requireToken(): string {
    if (!this.token) throw abortError();
    return this.token;
  }

  private async begin(): Promise<void> {
    const head = this.options.sniffBytes === false ? undefined : await readHead(this.file);
    const res = await this.routeCall(
      {
        phase: "begin",
        file: { name: this.file.name, type: this.file.type, size: this.file.size },
        ...(head === undefined ? {} : { head }),
        ...(this.options.input === undefined ? {} : { input: this.options.input }),
      },
      this.cancelController.signal,
      1,
    );
    this.token = res.completionToken;
    this.layout(res.upload.partSize, res.upload.multipart !== false);
    this.applyUrls(res.upload.parts);
    writePending(this.storeKey, { completionToken: res.completionToken });
  }

  private async tryResume(): Promise<boolean> {
    const record = readPending(this.storeKey);
    if (!record) return false;
    try {
      const res = await this.routeCall({ phase: "parts", completionToken: record.completionToken, from: 1 }, this.cancelController.signal, 1);
      if (res.size !== this.file.size) throw new Error("not resumable");
      this.token = record.completionToken;
      this.layout(res.partSize, res.multipart !== false);
      this.applyBatch(res);
      return true;
    } catch (error) {
      if (isAbort(error)) throw error;
      clearPending(this.storeKey);
      return false;
    }
  }

  private firstMissing(): number {
    for (const part of this.parts.values()) if (part.etag === undefined) return part.n;
    return 1;
  }

  private layout(partSize: number, multipart: boolean): void {
    this.multipart = multipart;
    this.partSize = multipart ? Math.max(1, partSize) : Math.max(1, this.file.size);
    const count = Math.max(1, Math.ceil(this.file.size / this.partSize));
    this.parts.clear();
    for (let n = 1; n <= count; n++) {
      this.parts.set(n, { n, size: n === count ? this.file.size - this.partSize * (count - 1) : this.partSize });
    }
  }

  private applyUrls(parts: readonly WirePart[]): void {
    for (const part of parts) this.urls.set(part.n, { url: part.url, headers: part.headers ?? {} });
    this.urlsMintedAt = clock.now();
  }

  private applyBatch(res: WirePartsResponse): void {
    this.applyUrls(res.parts);
    for (const landed of res.landed) {
      const part = this.parts.get(landed.n);
      if (part) part.etag = landed.etag;
    }
  }

  private async runParts(): Promise<void> {
    const pending = [...this.parts.values()].filter((part) => part.etag === undefined).map((part) => part.n);
    let failure: unknown;
    const worker = async () => {
      while (pending.length && failure === undefined) {
        if (this.cancelController.signal.aborted) return;
        if (this.paused) {
          await this.waitResume();
          continue;
        }
        const n = pending.shift();
        const part = n === undefined ? undefined : this.parts.get(n);
        if (!part) continue;
        const offset = (part.n - 1) * this.partSize;
        try {
          await this.putWithRetry(part, this.file.slice(offset, offset + part.size));
          this.notify();
        } catch (error) {
          if (isAbort(error) && !this.cancelController.signal.aborted) {
            pending.unshift(part.n);
            continue;
          }
          failure ??= error;
          for (const flight of this.inflight.values()) flight.controller.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: PARTS_IN_FLIGHT }, worker));
    if (failure !== undefined) throw failure;
    if (this.cancelController.signal.aborted) throw abortError();
    const missing = [...this.parts.values()].filter((part) => part.etag === undefined);
    if (missing.length) throw new BlobError("request_failed", { message: `${missing.length} parts did not land`, status: 503 });
  }

  private waitResume(): Promise<void> {
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private async urlFor(n: number, attempt = 0): Promise<Signed> {
    const cached = this.urls.get(n);
    if (cached) return cached;
    this.batch ??= this.fetchBatch(n).finally(() => {
      this.batch = undefined;
    });
    await this.batch;
    const signed = this.urls.get(n);
    if (signed) return signed;
    if (attempt >= MAX_URL_BATCHES) throw new BlobError("request_failed", { message: `the route did not sign part ${n}`, status: 503 });
    return this.urlFor(n, attempt + 1);
  }

  private async fetchBatch(from: number): Promise<void> {
    this.applyBatch(await this.routeCall({ phase: "parts", completionToken: this.requireToken(), from }, this.cancelController.signal));
  }

  private async represign(n: number): Promise<void> {
    this.urls.clear();
    await this.fetchBatch(n);
  }

  private async putWithRetry(part: PartState, body: Blob): Promise<void> {
    const controller = new AbortController();
    const cancel = this.cancelController.signal;
    const onCancel = () => controller.abort();
    cancel.addEventListener("abort", onCancel, { once: true });
    const state: InFlight = { loaded: 0, backingOff: false, controller };
    this.inflight.set(part.n, state);
    try {
      let sentBytes = false;
      let lastStatus = 0;
      let httpAttempts = 0;
      let netAttempts = 0;
      let represigns = 0;
      let waits = 0;
      for (;;) {
        if (controller.signal.aborted) throw abortError();
        if (clock.now() - this.urlsMintedAt >= PRESIGN_STALE_MS && this.urls.has(part.n)) this.urls.clear();
        const { url, headers } = await this.urlFor(part.n);
        const mintedAt = this.urlsMintedAt;
        const release = await acquire(controller.signal);
        let status = 0;
        let retryAfter: string | null = null;
        let etag: string | null = null;
        try {
          const res = await sendXhr({
            method: "PUT",
            url,
            headers,
            body,
            signal: controller.signal,
            onUploadProgress: (loaded) => {
              if (loaded > 0) sentBytes = true;
              state.loaded = Math.min(loaded, part.size);
              this.notify();
            },
            stallTimeoutMs: STALL_TIMEOUT_MS,
          });
          status = res.status;
          if (status >= 200 && status < 300) etag = res.header("etag");
          else if (status === 429 || status === 503 || sameOrigin(url)) retryAfter = res.header("retry-after");
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
          status = 0;
        } finally {
          release();
        }
        if (status >= 200 && status < 300) {
          part.etag = etag ?? "";
          return;
        }

        state.loaded = 0;
        this.notify();
        if (this.paused) throw abortError();
        lastStatus = status;
        const verdict = classify(status);
        if (verdict === "fail") throw putError(status, false);
        if (verdict === "represign") {
          const expired = clock.now() - mintedAt >= PRESIGN_STALE_MS;
          if ((!expired && this.represigned.has(part.n)) || represigns >= MAX_ATTEMPTS) throw putError(status, true);
          represigns += 1;
          this.represigned.add(part.n);
          await this.represign(part.n);
          continue;
        }
        if (status === 0 ? ++netAttempts >= networkAttemptCap(sentBytes) : ++httpAttempts >= MAX_ATTEMPTS) break;
        state.backingOff = true;
        this.notify();
        try {
          await clock.sleep(backoffMs(waits++, retryAfter), controller.signal);
        } finally {
          state.backingOff = false;
          this.notify();
        }
      }
      throw new BlobError("request_failed", {
        message: `upload failed after ${httpAttempts + netAttempts} attempts${lastStatus ? ` (last status ${lastStatus})` : ""}`,
        status: 503,
        hint: netAttempts > 0 && !sentBytes ? CORS_HINT : "the parts that landed are kept: task.retry(), or pick the same file again",
      });
    } finally {
      cancel.removeEventListener("abort", onCancel);
      this.inflight.delete(part.n);
      this.notify();
    }
  }

  private async routeCall<P extends Phase>(
    body: Extract<WireRequest, { phase: P }>,
    signal: AbortSignal | undefined,
    attempts = ROUTE_ATTEMPTS,
  ): Promise<RouteResponses[P]> {
    let last: BlobError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw abortError();
      const authored = await resolveHeaders(this.options.headers);
      let res: Response;
      try {
        res = await fetch(this.options.route, {
          method: "POST",
          headers: { "content-type": "application/json", ...authored },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw abortError();
        last = new BlobError("request_failed", { message: "could not reach the upload route", status: 503, cause: error });
        if (attempt === attempts - 1) break;
        await clock.sleep(backoffMs(attempt), signal);
        continue;
      }
      const json = parseJson(await res.text());
      if (res.ok) return json as RouteResponses[P];
      const error = routeError(json, res);
      if (classify(res.status) !== "retry") throw error;
      last = error;
      if (attempt === attempts - 1) break;
      await clock.sleep(backoffMs(attempt, res.headers.get("retry-after")), signal);
    }
    throw last ?? new BlobError("request_failed");
  }
}

const networkAttemptCap = (sentBytes: boolean): number => {
  if (sentBytes) return MAX_NETWORK_ATTEMPTS;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return offline ? MAX_NETWORK_ATTEMPTS : NO_BYTES_NETWORK_ATTEMPTS;
};

const sameOrigin = (url: string): boolean => {
  if (typeof location === "undefined") return false;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
};

const putError = (status: number, afterRepresign: boolean): BlobError => {
  if (afterRepresign) return new BlobError("signature_mismatch");
  if (status === 413) return new BlobError("too_large", { message: "storage refused the body as too large" });
  return new BlobError("request_failed", { message: `storage responded ${status}`, status: status || 503 });
};

export const parseJson = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

const routeMessage = (json: unknown, res: { status: number; statusText: string }): string => {
  if (typeof json === "object" && json !== null) {
    if ("error" in json && typeof json.error === "string" && json.error) return json.error;
    if ("message" in json && typeof json.message === "string") return json.message;
  }
  return res.statusText || `request failed with ${res.status}`;
};

export const routeError = (json: unknown, res: { status: number; statusText: string }): BlobError =>
  BlobError.fromJSON(json, res.status) ?? BlobError.fromStatus(res.status, { message: routeMessage(json, res) });

export const resolveHeaders = async (headers: HeadersProvider | undefined): Promise<Record<string, string>> => (headers ? await headers() : {});

const readHead = async (file: Blob): Promise<string | undefined> => {
  try {
    const bytes = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  } catch {
    return undefined;
  }
};
