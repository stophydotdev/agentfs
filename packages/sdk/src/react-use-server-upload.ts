import { useCallback, useRef } from "react";

import { clock } from "./browser-clock";
import type { HeadersProvider } from "./browser-task";
import type { BlobError } from "./errors";
import { deny, useConstraints } from "./react-constraints";
import { ServerUploadTask } from "./react-server-upload-task";
import { useTaskList, type ListEntry } from "./react-task-list";
import type { ServedConstraints } from "./wire";

export type ServerUploadResponse<TResponse> = TResponse;

export interface ServerUploadRecordBase {
  readonly id: string;
  readonly file: File | null;
  cancel(): boolean;
  loaded: number;
  total: number;
  percent: number;
  pending: boolean;
}

export type DoneServerUpload<TResponse> = ServerUploadRecordBase & { status: "done"; response: TResponse; error?: undefined };
export type FailedServerUpload = ServerUploadRecordBase & { status: "error"; error: BlobError; response?: undefined };

export type ServerUploadRecord<TResponse = unknown> =
  | (ServerUploadRecordBase & { status: "queued" | "uploading" | "finishing"; response?: undefined; error?: undefined })
  | DoneServerUpload<TResponse>
  | (ServerUploadRecordBase & { status: "canceled"; response?: undefined; error?: undefined })
  | FailedServerUpload;

export type ServerUploadStartArgs = { file?: File | null } | { body?: File | Blob | FormData | null };

export interface UseServerUploadOptions<R> {
  headers?: HeadersProvider | undefined;
  concurrency?: number | undefined;
  field?: string | undefined;
  onDone?: ((upload: DoneServerUpload<ServerUploadResponse<R>>) => void) | undefined;
  onError?: ((upload: FailedServerUpload) => void) | undefined;
}

export interface UseServerUploadResult<R> {
  start(args: ServerUploadStartArgs): ServerUploadRecord<ServerUploadResponse<R>> | null;
  uploads: ServerUploadRecord<ServerUploadResponse<R>>[];
  upload: ServerUploadRecord<ServerUploadResponse<R>> | null;
  clear(id?: string): void;
  accept: string;
  constraints: ServedConstraints | undefined;
}

interface Payload {
  body: XMLHttpRequestBodyInit;
  file: File | null;
  total: number;
}

let refusedCounter = 0;

export const payloadOf = (args: ServerUploadStartArgs, field: string): Payload | null => {
  if ("file" in args) {
    if (!args.file) return null;
    const form = new FormData();
    form.append(field, args.file);
    return { body: form, file: args.file, total: args.file.size };
  }
  const body = "body" in args ? args.body : null;
  if (!body) return null;
  if (body instanceof FormData) return { body, file: null, total: 0 };
  return { body, file: body instanceof File ? body : null, total: body.size };
};

const serverUploadEntry = <TResponse>(task: ServerUploadTask<TResponse>): ListEntry<ServerUploadRecord<TResponse>> => {
  const cancel = () => task.cancel();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => ({ id: task.id, file: task.file, cancel, ...task.snapshot() }),
    start: () => task.start(),
  };
};

const refusedEntry = <TResponse>(file: File, error: BlobError): ListEntry<ServerUploadRecord<TResponse>> => {
  const id = `q${++refusedCounter}-${clock.now().toString(36)}`;
  const record: FailedServerUpload = { id, file, cancel: () => false, loaded: 0, total: file.size, percent: 0, pending: false, status: "error", error };
  return { id, subscribe: () => () => {}, status: () => "error", record: () => record, start: () => {} };
};

export const useServerUpload = <R = unknown>(route: string, options: UseServerUploadOptions<R> = {}): UseServerUploadResult<R> => {
  const headersRef = useRef(options.headers);
  headersRef.current = options.headers;
  const fieldRef = useRef(options.field ?? "file");
  fieldRef.current = options.field ?? "file";
  const handlers = useRef(options);
  handlers.current = options;

  const { constraintsRef, constraints, accept } = useConstraints(route, options.headers);

  const { uploads, task, add, clear } = useTaskList<ServerUploadRecord<R>>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === "done") handlers.current.onDone?.(record);
    },
    onError: (record) => {
      if (record.status === "error") handlers.current.onError?.(record);
    },
  });

  const start = useCallback(
    (args: ServerUploadStartArgs) => {
      const payload = payloadOf(args, fieldRef.current);
      if (!payload) return null;
      const refusal = payload.file ? deny(payload.file, constraintsRef.current) : undefined;
      const entry = refusal && payload.file
        ? refusedEntry<R>(payload.file, refusal)
        : serverUploadEntry(new ServerUploadTask<R>({ route, headers: headersRef.current, ...payload }));
      return add([entry])[0] ?? null;
    },
    [add, route, constraintsRef],
  );

  return { start, uploads, upload: task, clear, accept, constraints };
};
