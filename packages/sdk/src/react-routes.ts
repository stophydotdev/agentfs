export type AnyUploadRoute = { readonly __agentfsUploadRoute: { readonly input: unknown; readonly data: unknown } };

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

export type RoutesOf<T> = UnionToIntersection<T extends { readonly __agentfsUploadHandler: infer TRoutes } ? TRoutes : never>;

export type RouteKey<T> = Extract<keyof RoutesOf<T>, string>;

export type RouteAt<T, K> = K extends keyof RoutesOf<T> ? RoutesOf<T>[K] : never;

export type SoleRoute<T> = RoutesOf<T> extends { readonly "": infer R } ? R : never;

export type RouteInput<R> = R extends { readonly __agentfsUploadRoute: { readonly input: infer TInput } } ? TInput : undefined;

export type RouteData<R> = R extends { readonly __agentfsUploadRoute: { readonly data: infer TData } } ? TData : unknown;

export const DEFAULT_ENDPOINT = "/api/upload";

export const resolveRouteUrl = (route: string, endpoint?: string): string => {
  const base = endpoint || DEFAULT_ENDPOINT;
  if (!route) return base;
  if (route.startsWith("/") || route.startsWith("http")) return route;
  return `${base}${base.includes("?") ? "&" : "?"}route=${encodeURIComponent(route)}`;
};
