import { createClient } from "./client";
import { BlobError } from "./errors";
import type { StoredFile } from "./schemas";
import { parseSize, type Size } from "./units";

export { BlobError } from "./errors";
export type { BlobErrorCode } from "./errors";

export interface UploadOptions {
  token: string;
  path: string;
  baseUrl?: string;
  multipart?: boolean | Size;
  onProgress?: (uploaded: number, total: number) => void;
}

export interface UploadedBlob {
  path: string;
  url?: string;
  versionedUrl?: string;
  size: number;
  etag: string;
  contentType: string;
}

export interface UploadTask {
  done: Promise<UploadedBlob>;
  cancel: () => void;
}

const uploaded = (file: StoredFile): UploadedBlob => ({
  path: file.path,
  ...(file.url ? { url: file.url } : {}),
  ...(file.versioned_url ? { versionedUrl: file.versioned_url } : {}),
  size: file.size_bytes,
  etag: file.etag ?? "",
  contentType: file.content_type,
});

export const upload = (file: Blob, options: UploadOptions): UploadTask => {
  const controller = new AbortController();
  const client = createClient({ token: options.token, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
  const threshold = options.multipart === true ? 0 : options.multipart === false ? Number.POSITIVE_INFINITY : parseSize(options.multipart ?? "16mb", "multipart");
  const write = { signal: controller.signal, ...(options.onProgress ? { onProgress: options.onProgress } : {}) };
  const done = (file.size > 0 && file.size > threshold
    ? client.uploadInParts(options.path, file, write)
    : client.putFile(options.path, file, write)
  ).then(uploaded, (error: unknown) => {
    if (controller.signal.aborted) throw new BlobError("request_failed", { message: "The upload was canceled", status: 499 });
    throw error;
  });
  return { done, cancel: () => controller.abort() };
};
