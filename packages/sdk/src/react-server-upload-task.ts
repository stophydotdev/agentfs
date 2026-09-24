import { clock } from "./browser-clock";
import { parseJson, resolveHeaders, routeError, type HeadersProvider } from "./browser-task";
import { NetworkError, sendXhr, type XhrResponse } from "./browser-xhr";
import { BlobError } from "./errors";

const PLATFORM_BODY_CAP_HINT = "the platform in front of your route refused the body before the route ran: send large files with useUpload, which goes straight to storage";

export type ServerUploadSnapshot<TResponse> = {
  loaded: number;
  total: number;
  percent: number;
  pending: boolean;
} & (
  | { status: "queued" | "uploading" | "finishing"; response?: undefined; error?: undefined }
  | { status: "done"; response: TResponse; error?: undefined }
  | { status: "canceled"; response?: undefined; error?: undefined }
  | { status: "error"; error: BlobError; response?: undefined }
);

export interface ServerUploadTaskOptions {
  route: string;
  headers?: HeadersProvider | undefined;
  body: XMLHttpRequestBodyInit;
  file: File | null;
  total: number;
}

type Status = ServerUploadSnapshot<unknown>["status"];

let counter = 0;

export class ServerUploadTask<TResponse = unknown> {
  readonly id = `p${++counter}-${clock.now().toString(36)}`;
  readonly file: File | null;

  private status: Status = "queued";
  private loaded = 0;
  private total: number;
  private response: TResponse | undefined;
  private error: BlobError | undefined;
  private started = false;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private cached: ServerUploadSnapshot<TResponse> | undefined;
  private frameQueued = false;

  constructor(private readonly options: ServerUploadTaskOptions) {
    this.file = options.file;
    this.total = options.total;
  }

  snapshot(): ServerUploadSnapshot<TResponse> {
    if (this.cached) return this.cached;
    const done = this.status === "done";
    const base = {
      loaded: done ? this.total : this.loaded,
      total: this.total,
      percent: done ? 100 : this.total > 0 ? Math.min(100, Math.floor((this.loaded / this.total) * 100)) : 0,
      pending: this.status === "queued" || this.status === "uploading" || this.status === "finishing",
    };
    if (this.status === "done") this.cached = { ...base, status: "done", response: this.response as TResponse };
    else if (this.status === "error" && this.error) this.cached = { ...base, status: "error", error: this.error };
    else if (this.status === "canceled") this.cached = { ...base, status: "canceled" };
    else this.cached = { ...base, status: this.status === "error" ? "finishing" : this.status };
    return this.cached;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  cancel(): boolean {
    if (this.status === "done" || this.status === "error" || this.status === "canceled") return false;
    this.status = "canceled";
    this.controller.abort();
    this.notify();
    return true;
  }

  private async run(): Promise<void> {
    this.status = "uploading";
    this.notify();
    let authored: Record<string, string>;
    try {
      authored = await resolveHeaders(this.options.headers);
    } catch (error) {
      if (this.canceled()) return;
      this.fail(BlobError.is(error) ? error : new BlobError("request_failed", { message: error instanceof Error ? error.message : String(error), status: 400, cause: error }));
      return;
    }
    if (this.canceled()) return;
    let res: XhrResponse;
    try {
      res = await sendXhr({
        method: "POST",
        url: this.options.route,
        headers: authored,
        body: this.options.body,
        signal: this.controller.signal,
        onUploadProgress: (loaded, total) => {
          this.loaded = loaded;
          if (total > 0) this.total = total;
          this.notify();
        },
        onUploadDone: () => {
          if (this.status === "uploading") this.status = "finishing";
          this.notify();
        },
      });
    } catch (error) {
      if (this.canceled()) return;
      const message = error instanceof NetworkError ? "could not reach the route" : error instanceof Error ? error.message : String(error);
      this.fail(new BlobError("request_failed", { message, status: 503, cause: error }));
      return;
    }
    if (this.canceled()) return;
    const json = parseJson(res.text);
    if (res.status >= 200 && res.status < 300) {
      this.response = json as TResponse;
      this.status = "done";
      this.notify();
      return;
    }
    const authoredError = BlobError.fromJSON(json, res.status);
    if (authoredError) this.fail(authoredError);
    else if (res.status === 413) this.fail(new BlobError("too_large", { hint: PLATFORM_BODY_CAP_HINT }));
    else this.fail(routeError(json, res));
  }

  private canceled(): boolean {
    return this.status === "canceled";
  }

  private fail(error: BlobError): void {
    this.error = error;
    this.status = "error";
    this.notify();
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
}
