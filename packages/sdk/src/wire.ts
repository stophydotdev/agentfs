import type { BlobError, BlobErrorJSON } from "./errors";

export interface UploadFile {
  name: string;
  type: string;
  size: number;
}

export interface ServedConstraints {
  contentTypes?: readonly string[];
  maxSize?: number;
}

export interface WirePart {
  n: number;
  url: string;
  headers?: Record<string, string>;
}

export interface WireUploadPlan {
  partSize: number;
  parts: WirePart[];
  multipart: boolean;
}

export interface WireBeginResponse {
  completionToken: string;
  path: string;
  upload: WireUploadPlan;
}

export interface WireLanded {
  n: number;
  etag: string;
}

export interface WirePartsResponse {
  partSize: number;
  size: number;
  parts: WirePart[];
  landed: WireLanded[];
  multipart: boolean;
}

export interface WireBlob {
  path: string;
  url?: string;
  versionedUrl?: string;
  size: number;
  etag: string;
  uploadedAt: string;
  contentType: string;
}

export interface WireEndResponse<TData = unknown> {
  blob: WireBlob;
  data: TData;
}

export interface WireConstraintsResponse {
  constraints: ServedConstraints;
}

export interface WireCancelResponse {
  ok: true;
}

export type WireRequest =
  | { phase: "begin"; file: UploadFile; head?: string; input?: unknown }
  | { phase: "parts"; completionToken: string; from: number }
  | { phase: "end"; completionToken: string; parts?: WireLanded[] }
  | { phase: "cancel"; completionToken: string };

export type WireError = BlobErrorJSON;

export interface UploadedBlob {
  path: string;
  url?: string;
  versionedUrl?: string;
  size: number;
  etag: string;
  uploadedAt: Date;
  contentType: string;
}

export type UploadSnapshot = {
  loaded: number;
  total: number;
  percent: number;
  canPause: boolean;
  pending: boolean;
  stalled: boolean;
} & (
  | { status: "queued" | "uploading" | "finishing" | "paused"; blob?: undefined; error?: undefined }
  | { status: "done"; blob: UploadedBlob & { data: unknown }; error?: undefined }
  | { status: "canceled"; blob?: undefined; error?: undefined }
  | { status: "error"; error: BlobError; blob?: undefined }
);

export interface UploadTask {
  readonly id: string;
  readonly file: File;
  snapshot(): UploadSnapshot;
  subscribe(onChange: () => void): () => void;
  readonly done: Promise<UploadedBlob & { data: unknown }>;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  retry(): boolean;
}

export interface UploadRouteTypes<TInput, TData, TRoute extends string = string> {
  input: TInput;
  data: TData;
  route: TRoute;
}

export const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

export const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
