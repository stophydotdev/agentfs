import { BlobError } from "./errors";
import { abortError, clock, isAbort } from "./browser-clock";
import { createTask, parseJson, resolveHeaders, routeError, type Done, type UploadOptions } from "./browser-task";
import { NetworkError, sendXhr } from "./browser-xhr";
import type { UploadSnapshot, UploadTask, WireEndResponse } from "./wire";

export { BlobError } from "./errors";
export type { BlobErrorCode } from "./errors";
export { formatBytes, type Size } from "./units";
export type { UploadedBlob, UploadSnapshot, UploadTask } from "./wire";
export type { HeadersProvider, UploadOptions } from "./browser-task";

export const upload = <TInput = unknown>(file: File, options: UploadOptions<TInput>): UploadTask => createTask(file, options, true);

let counter = 0;

export const uploadThroughServer = <TInput = unknown>(file: File, options: UploadOptions<TInput>): UploadTask => {
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  let status: UploadSnapshot["status"] = "uploading";
  let loaded = 0;
  let blob: Done | undefined;
  let error: BlobError | undefined;
  const notify = () => clock.frame(() => listeners.forEach((listener) => listener()));

  const run = async (): Promise<Done> => {
    const authored = await resolveHeaders(options.headers);
    if (controller.signal.aborted) throw abortError();
    const res = await sendXhr({
      method: "POST",
      url: options.route,
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-upload-name": encodeURIComponent(file.name),
        ...(options.input === undefined ? {} : { "x-upload-input": encodeURIComponent(JSON.stringify(options.input)) }),
        ...authored,
      },
      body: file,
      signal: controller.signal,
      onUploadProgress: (sent) => {
        loaded = Math.min(sent, file.size);
        notify();
      },
      onUploadDone: () => {
        if (status === "uploading") status = "finishing";
        notify();
      },
    }).catch((caught: unknown) => {
      if (caught instanceof NetworkError) throw new BlobError("request_failed", { message: "could not reach the upload route", status: 503, cause: caught });
      throw caught;
    });
    const json = parseJson(res.text);
    if (res.status < 200 || res.status >= 300) throw routeError(json, res);
    const { blob: wire, data } = json as WireEndResponse;
    return { ...wire, uploadedAt: new Date(wire.uploadedAt), data };
  };

  const done = run().then(
    (result) => {
      blob = result;
      loaded = file.size;
      status = "done";
      notify();
      return result;
    },
    (caught: unknown) => {
      if (status === "canceled" || isAbort(caught)) throw abortError();
      error = BlobError.is(caught) ? caught : new BlobError("request_failed", { message: String(caught), status: 503, cause: caught });
      status = "error";
      notify();
      throw error;
    },
  );
  done.catch(() => {});

  return {
    id: `s${++counter}-${clock.now().toString(36)}`,
    file,
    snapshot: () => {
      const base = {
        loaded,
        total: file.size,
        percent: status === "done" ? 100 : file.size > 0 ? Math.min(99, Math.floor((loaded / file.size) * 100)) : 0,
        canPause: false,
        pending: status === "uploading" || status === "finishing",
        stalled: false,
      };
      if (status === "done" && blob) return { ...base, status, blob };
      if (status === "error" && error) return { ...base, status, error };
      if (status === "canceled") return { ...base, status };
      return { ...base, status: status === "finishing" ? "finishing" : "uploading" };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    done,
    pause: () => false,
    resume: () => false,
    cancel: () => {
      if (status !== "uploading" && status !== "finishing") return false;
      status = "canceled";
      controller.abort();
      notify();
      return true;
    },
    retry: () => false,
  };
};
