import type { HeadersProvider } from "./browser-task";
import type { BlobError } from "./errors";
import type { AnyUploadRoute, RouteAt, RouteKey, SoleRoute } from "./react-routes";
import { useUpload, type UseUploadOptions, type UseUploadResult } from "./react-use-upload";

export { useUpload } from "./react-use-upload";
export type {
  DoneRecordOf,
  DoneUpload,
  FailedRecordOf,
  FailedUpload,
  RecordOf,
  StartOf,
  UploadRecord,
  UploadRecordBase,
  UploadStart,
  UseUploadOptions,
  UseUploadResult,
} from "./react-use-upload";
export { useServerUpload } from "./react-use-server-upload";
export type {
  DoneServerUpload,
  FailedServerUpload,
  ServerUploadRecord,
  ServerUploadRecordBase,
  ServerUploadResponse,
  ServerUploadStartArgs,
  UseServerUploadOptions,
  UseServerUploadResult,
} from "./react-use-server-upload";
export type { ServerUploadSnapshot } from "./react-server-upload-task";
export type { AnyUploadRoute, RouteAt, RouteData, RouteInput, RouteKey, RoutesOf, SoleRoute } from "./react-routes";
export { BlobError } from "./errors";
export type { BlobErrorCode } from "./errors";
export { formatBytes, type Size } from "./units";
export type { ServedConstraints, UploadedBlob, UploadFile, UploadSnapshot, UploadTask } from "./wire";
export type { HeadersProvider } from "./browser-task";

export interface FailedAnyUpload {
  readonly id: string;
  readonly file: File;
  readonly error: BlobError;
}

export interface UploadDefaults {
  headers?: HeadersProvider;
  concurrency?: number;
  endpoint?: string;
  onError?: (upload: FailedAnyUpload) => void;
}

export interface BoundUseUpload<T> {
  (...args: [SoleRoute<T>] extends [never] ? [route: never] : [options?: UseUploadOptions<SoleRoute<T>>]): UseUploadResult<SoleRoute<T>>;
  <K extends RouteKey<T>>(route: K, options?: UseUploadOptions<RouteAt<T, K>>): UseUploadResult<RouteAt<T, K>>;
}

export interface UploadHooks<T> {
  useUpload: BoundUseUpload<T>;
}

export interface UnboundUploadHooks {
  useUpload: typeof useUpload;
}

export function uploadHooks<T = never>(defaults?: UploadDefaults): [T] extends [never] ? UnboundUploadHooks : UploadHooks<T>;
export function uploadHooks(defaults: UploadDefaults = {}): UnboundUploadHooks {
  const merge = <R>(options: UseUploadOptions<R> = {}): UseUploadOptions<R> => ({
    ...options,
    endpoint: options.endpoint ?? defaults.endpoint,
    headers: options.headers ?? defaults.headers,
    concurrency: options.concurrency ?? defaults.concurrency,
    onError: defaults.onError
      ? (upload) => {
          try {
            defaults.onError?.(upload);
          } catch (error) {
            console.error("[agentfs] uploadHooks onError threw", error);
          }
          options.onError?.(upload);
        }
      : options.onError,
  });
  const bound = <R extends AnyUploadRoute>(routeOrOptions?: string | UseUploadOptions<R>, maybeOptions?: UseUploadOptions<R>): UseUploadResult<R> =>
    typeof routeOrOptions === "string" ? useUpload<R>(routeOrOptions, merge(maybeOptions)) : useUpload<R>("", merge(routeOrOptions));
  return { useUpload: bound };
}
