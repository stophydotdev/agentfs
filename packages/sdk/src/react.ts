import { useCallback, useRef, useState } from "react";

import { upload, type UploadedBlob, type UploadTask } from "./browser";
import { BlobError } from "./errors";

export { BlobError } from "./errors";

export type UploadStatus = "idle" | "uploading" | "done" | "canceled" | "error";

export interface UploadTarget {
  token: string;
  path: string;
}

export interface UseUploadOptions {
  getTarget: (file: File) => Promise<UploadTarget>;
  baseUrl?: string;
}

export interface UploadState {
  status: UploadStatus;
  percent: number;
  blob: UploadedBlob | undefined;
  error: BlobError | undefined;
}

const IDLE: UploadState = { status: "idle", percent: 0, blob: undefined, error: undefined };

export const useUpload = ({ getTarget, baseUrl }: UseUploadOptions) => {
  const [state, setState] = useState<UploadState>(IDLE);
  const task = useRef<UploadTask | undefined>(undefined);

  const start = useCallback(async (file: File): Promise<UploadedBlob | undefined> => {
    setState({ ...IDLE, status: "uploading" });
    try {
      const target = await getTarget(file);
      task.current = upload(file, {
        ...target,
        ...(baseUrl ? { baseUrl } : {}),
        onProgress: (sent, total) => setState((current) => ({ ...current, percent: total ? Math.min(99, Math.round((sent / total) * 100)) : 99 })),
      });
      const blob = await task.current.done;
      setState({ status: "done", percent: 100, blob, error: undefined });
      return blob;
    } catch (caught) {
      const error = BlobError.is(caught) ? caught : new BlobError("request_failed", { message: String(caught), status: 0 });
      setState((current) => ({ ...current, status: current.status === "canceled" ? "canceled" : "error", error }));
      return undefined;
    }
  }, [getTarget, baseUrl]);

  const cancel = useCallback(() => {
    setState((current) => ({ ...current, status: "canceled" }));
    task.current?.cancel();
  }, []);

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, start, cancel, reset };
};
