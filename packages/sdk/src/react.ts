import { useCallback, useEffect, useRef, useState } from "react";

import { upload, uploadThroughServer, type HeadersProvider } from "./browser";
import type { BlobError } from "./errors";
import type { UploadHandler, UploadRouteDefinition } from "./handler";
import type { ServedConstraints, UploadedBlob, UploadSnapshot, UploadTask, WireConstraintsResponse } from "./wire";

export { BlobError } from "./errors";
export { formatBytes, type Size } from "./units";
export type { UploadedBlob, UploadSnapshot, UploadTask } from "./wire";

export type RoutesOf<THandler> = THandler extends UploadHandler<infer TRoutes, unknown> ? TRoutes : Record<string, UploadRouteDefinition<unknown, unknown>>;
export type RouteKey<THandler> = keyof RoutesOf<THandler> & string;
type RouteTypes<THandler, K extends RouteKey<THandler>> = RoutesOf<THandler>[K] extends UploadRouteDefinition<infer TInput, infer TData>
  ? { input: TInput; data: TData }
  : { input: unknown; data: unknown };

export type UploadRecord<TData = unknown> = {
  readonly id: string;
  readonly file: File;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  retry(): boolean;
} & Omit<UploadSnapshot, "blob"> & { blob?: UploadedBlob & { data: TData } };

export interface UseUploadOptions<TData = unknown> {
  endpoint?: string;
  headers?: HeadersProvider;
  concurrency?: number;
  onDone?: (upload: UploadRecord<TData> & { status: "done" }) => void;
  onError?: (upload: UploadRecord<TData> & { status: "error"; error: BlobError }) => void;
}

export interface UseUploadResult<TInput = unknown, TData = unknown> {
  start: (file: File, ...input: undefined extends TInput ? [input?: TInput] : [input: TInput]) => Promise<UploadRecord<TData>>;
  uploads: UploadRecord<TData>[];
  upload: UploadRecord<TData> | null;
  clear(id?: string): void;
  accept: string;
  constraints: ServedConstraints | undefined;
}

export interface UploadDefaults {
  endpoint?: string;
  headers?: HeadersProvider;
  onError?: (upload: UploadRecord & { status: "error"; error: BlobError }) => void;
}

const DEFAULT_ENDPOINT = "/api/upload";

const routeUrl = (route: string, endpoint: string): string =>
  route.startsWith("/") || route.startsWith("http") ? route : route ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}route=${encodeURIComponent(route)}` : endpoint;

const recordOf = <TData>(task: UploadTask): UploadRecord<TData> => {
  const { blob, ...snapshot } = task.snapshot();
  return {
    ...snapshot,
    ...(blob ? { blob: blob as UploadedBlob & { data: TData } } : {}),
    id: task.id,
    file: task.file,
    pause: task.pause,
    resume: task.resume,
    cancel: task.cancel,
    retry: task.retry,
  };
};

const useConstraints = (url: string, headers: HeadersProvider | undefined) => {
  const [constraints, setConstraints] = useState<ServedConstraints | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void (async () => {
      const response = await fetch(url, { headers: (await headers?.()) ?? {} });
      if (response.ok && live) setConstraints(((await response.json()) as WireConstraintsResponse).constraints);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url, headers]);
  return constraints;
};

const useTasks = <TInput, TData>(
  start: (file: File, input: TInput | undefined) => UploadTask,
  options: UseUploadOptions<TData>,
  constraints: ServedConstraints | undefined,
): UseUploadResult<TInput, TData> => {
  const [records, setRecords] = useState<UploadRecord<TData>[]>([]);
  const tasks = useRef(new Map<string, UploadTask>());
  const refresh = useCallback(() => setRecords([...tasks.current.values()].map((task) => recordOf<TData>(task))), []);

  const begin = useCallback(async (file: File, input?: TInput): Promise<UploadRecord<TData>> => {
    const task = start(file, input);
    tasks.current.set(task.id, task);
    task.subscribe(() => {
      refresh();
      const record = recordOf<TData>(task);
      if (record.status === "done") options.onDone?.(record as UploadRecord<TData> & { status: "done" });
      if (record.status === "error" && record.error) options.onError?.(record as UploadRecord<TData> & { status: "error"; error: BlobError });
    });
    refresh();
    await task.done.catch(() => undefined);
    return recordOf<TData>(task);
  }, [start, refresh, options]);

  const clear = useCallback((id?: string) => {
    for (const [key, task] of tasks.current) {
      if (id !== undefined && key !== id) continue;
      if (!task.snapshot().pending) tasks.current.delete(key);
    }
    refresh();
  }, [refresh]);

  return {
    start: begin as UseUploadResult<TInput, TData>["start"],
    uploads: records,
    upload: records.at(-1) ?? null,
    clear,
    accept: constraints?.contentTypes?.join(",") ?? "",
    constraints,
  };
};

export function useUpload<TInput = unknown, TData = unknown>(route?: string, options: UseUploadOptions<TData> = {}): UseUploadResult<TInput, TData> {
  const url = routeUrl(route ?? "", options.endpoint ?? DEFAULT_ENDPOINT);
  const constraints = useConstraints(url, options.headers);
  const start = useCallback((file: File, input: TInput | undefined) => upload(file, {
    route: url,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(input === undefined ? {} : { input }),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    sniffBytes: constraints?.contentTypes !== undefined,
  }), [url, options.headers, options.concurrency, constraints]);
  return useTasks<TInput, TData>(start, options, constraints);
}

export function useServerUpload<TInput = unknown, TData = unknown>(route?: string, options: UseUploadOptions<TData> = {}): UseUploadResult<TInput, TData> {
  const url = routeUrl(route ?? "", options.endpoint ?? DEFAULT_ENDPOINT);
  const constraints = useConstraints(url, options.headers);
  const start = useCallback((file: File, input: TInput | undefined) => uploadThroughServer(file, {
    route: url,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(input === undefined ? {} : { input }),
  }), [url, options.headers]);
  return useTasks<TInput, TData>(start, options, constraints);
}

export interface UploadHooks<THandler> {
  useUpload: <K extends RouteKey<THandler>>(
    ...args: "" extends K ? [route?: K, options?: UseUploadOptions<RouteTypes<THandler, K>["data"]>] : [route: K, options?: UseUploadOptions<RouteTypes<THandler, K>["data"]>]
  ) => UseUploadResult<RouteTypes<THandler, K>["input"], RouteTypes<THandler, K>["data"]>;
  useServerUpload: <K extends RouteKey<THandler>>(
    ...args: "" extends K ? [route?: K, options?: UseUploadOptions<RouteTypes<THandler, K>["data"]>] : [route: K, options?: UseUploadOptions<RouteTypes<THandler, K>["data"]>]
  ) => UseUploadResult<RouteTypes<THandler, K>["input"], RouteTypes<THandler, K>["data"]>;
}

export function uploadHooks<THandler>(defaults: UploadDefaults = {}): UploadHooks<THandler> {
  const merge = (options: UseUploadOptions | undefined): UseUploadOptions => {
    const merged: UseUploadOptions = { ...options };
    if (defaults.endpoint && !merged.endpoint) merged.endpoint = defaults.endpoint;
    if (defaults.headers && !merged.headers) merged.headers = defaults.headers;
    if (defaults.onError && !merged.onError) merged.onError = defaults.onError;
    return merged;
  };
  return {
    useUpload: ((route?: string, options?: UseUploadOptions) => useUpload(route, merge(options))) as UploadHooks<THandler>["useUpload"],
    useServerUpload: ((route?: string, options?: UseUploadOptions) => useServerUpload(route, merge(options))) as UploadHooks<THandler>["useServerUpload"],
  };
}
