import { useCallback, useRef } from "react";

import { clock } from "./browser-clock";
import { createTask, type HeadersProvider, type InternalTask } from "./browser-task";
import type { BlobError } from "./errors";
import type { UploadRouteDefinition } from "./handler";
import { deny, useConstraints } from "./react-constraints";
import { resolveRouteUrl, type AnyUploadRoute, type RouteData, type RouteInput } from "./react-routes";
import { useTaskList, type ListEntry } from "./react-task-list";
import type { ServedConstraints, UploadedBlob } from "./wire";

export interface UploadRecordBase {
  readonly id: string;
  readonly file: File;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  retry(): boolean;
  loaded: number;
  total: number;
  percent: number;
  canPause: boolean;
  pending: boolean;
  stalled: boolean;
}

export type DoneUpload<TData> = UploadRecordBase & { status: "done"; blob: UploadedBlob & { data: TData }; error?: undefined };
export type FailedUpload = UploadRecordBase & { status: "error"; error: BlobError; blob?: undefined };

export type UploadRecord<TData = unknown> =
  | (UploadRecordBase & { status: "queued" | "uploading" | "finishing" | "paused"; blob?: undefined; error?: undefined })
  | DoneUpload<TData>
  | (UploadRecordBase & { status: "canceled"; blob?: undefined; error?: undefined })
  | FailedUpload;

export type RecordOf<R> = UploadRecord<RouteData<R>>;
export type DoneRecordOf<R> = DoneUpload<RouteData<R>>;
export type FailedRecordOf<_R> = FailedUpload;

type InputArg<TInput> = [TInput] extends [undefined] ? { input?: undefined } : { input: TInput };

export interface UploadStart<TInput, TData> {
  (args: { file: File | null | undefined } & InputArg<TInput>): UploadRecord<TData> | null;
  (args: { files: File[] | FileList | null | undefined } & InputArg<TInput>): UploadRecord<TData>[];
}

export type StartOf<R> = UploadStart<RouteInput<R>, RouteData<R>>;

export interface UseUploadOptions<R> {
  endpoint?: string | undefined;
  headers?: HeadersProvider | undefined;
  concurrency?: number | undefined;
  onDone?: ((upload: DoneRecordOf<R>) => void) | undefined;
  onError?: ((upload: FailedRecordOf<R>) => void) | undefined;
}

export interface UseUploadResult<R> {
  start: StartOf<R>;
  uploads: RecordOf<R>[];
  upload: RecordOf<R> | null;
  clear(id?: string): void;
  accept: string;
  constraints: ServedConstraints | undefined;
}

interface StartArgs {
  file?: File | null | undefined;
  files?: File[] | FileList | null | undefined;
  input?: unknown;
}

let refusedCounter = 0;

const taskEntry = <R>(task: InternalTask): ListEntry<RecordOf<R>> => {
  const pause = () => task.pause();
  const resume = () => task.resume();
  const cancel = () => task.cancel();
  const retry = () => task.retry();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => ({ id: task.id, file: task.file, pause, resume, cancel, retry, ...task.snapshot() }) as RecordOf<R>,
    start: () => task.start(),
  };
};

const refusedEntry = <R>(file: File, error: BlobError): ListEntry<RecordOf<R>> => {
  const id = `r${++refusedCounter}-${clock.now().toString(36)}`;
  const no = () => false;
  const record: FailedUpload = {
    id,
    file,
    pause: no,
    resume: no,
    cancel: no,
    retry: no,
    loaded: 0,
    total: file.size,
    percent: 0,
    canPause: false,
    pending: false,
    stalled: false,
    status: "error",
    error,
  };
  return { id, subscribe: () => () => {}, status: () => "error", record: () => record, start: () => {} };
};

export function useUpload<R extends AnyUploadRoute = UploadRouteDefinition<undefined, unknown>>(route: string, options: UseUploadOptions<R> = {}): UseUploadResult<R> {
  const url = resolveRouteUrl(route, options.endpoint);
  const headersRef = useRef(options.headers);
  headersRef.current = options.headers;
  const handlers = useRef(options);
  handlers.current = options;
  const { constraintsRef, constraints, accept } = useConstraints(url, options.headers);

  const { uploads, task: newest, add, clear } = useTaskList<RecordOf<R>>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === "done") handlers.current.onDone?.(record);
    },
    onError: (record) => {
      if (record.status === "error") handlers.current.onError?.(record);
    },
  });

  const start = useCallback(
    (args: StartArgs) => {
      const make = (file: File): ListEntry<RecordOf<R>> => {
        const known = constraintsRef.current;
        const refusal = deny(file, known);
        if (refusal) return refusedEntry<R>(file, refusal);
        const sniffBytes = known === undefined ? undefined : (known.contentTypes?.length ?? 0) > 0;
        return taskEntry<R>(createTask(file, {
          route: url,
          ...(headersRef.current ? { headers: headersRef.current } : {}),
          ...(args.input === undefined ? {} : { input: args.input }),
          ...(sniffBytes === undefined ? {} : { sniffBytes }),
        }, false));
      };
      if ("files" in args) return add(args.files ? Array.from(args.files, make) : []);
      if (!args.file) return null;
      return add([make(args.file)])[0] ?? null;
    },
    [add, url, constraintsRef],
  );

  return { start: start as StartOf<R>, uploads, upload: newest, clear, accept, constraints };
}
