import { useCallback, useEffect, useRef, useState } from "react";

import { clock } from "./browser-clock";
import { resolveHeaders, type HeadersProvider } from "./browser-task";
import { BlobError } from "./errors";
import { checkContentType } from "./sniff";
import { formatBytes } from "./units";
import type { ServedConstraints } from "./wire";

const CONSTRAINTS_TTL_MS = 60_000;

export interface RouteFacts {
  constraints: ServedConstraints | undefined;
  error?: BlobError;
}

interface Entry extends RouteFacts {
  at: number;
  etag: string | null;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<RouteFacts>>();

export const cachedFacts = (route: string): RouteFacts | undefined => {
  const entry = cache.get(route);
  return entry && clock.now() - entry.at <= CONSTRAINTS_TTL_MS ? entry : undefined;
};

export const loadFacts = (route: string, headers: HeadersProvider | undefined): Promise<RouteFacts> => {
  const hit = cachedFacts(route);
  if (hit) return Promise.resolve(hit);
  let pending = inFlight.get(route);
  if (!pending) {
    pending = fetchFacts(route, headers).finally(() => inFlight.delete(route));
    inFlight.set(route, pending);
  }
  return pending;
};

export const forgetFacts = (): void => {
  cache.clear();
  inFlight.clear();
};

const isConstraints = (value: unknown): value is { constraints: ServedConstraints } =>
  typeof value === "object" && value !== null && "constraints" in value && typeof value.constraints === "object" && value.constraints !== null;

const fetchFacts = async (route: string, headers: HeadersProvider | undefined): Promise<RouteFacts> => {
  let authored: Record<string, string>;
  try {
    authored = await resolveHeaders(headers);
  } catch (error) {
    return {
      constraints: undefined,
      error: BlobError.is(error) ? error : new BlobError("request_failed", { message: error instanceof Error ? error.message : String(error), status: 400, cause: error }),
    };
  }
  const stale = cache.get(route);
  let res: Response;
  try {
    res = await fetch(route, { headers: stale?.etag ? { ...authored, "if-none-match": stale.etag } : authored });
  } catch (error) {
    return { constraints: undefined, error: new BlobError("request_failed", { message: "could not reach the route", status: 503, cause: error }) };
  }
  if (res.status === 304 && stale) return remember(route, { constraints: stale.constraints }, stale.etag);
  if (res.status === 404 || res.status === 405) return remember(route, { constraints: undefined }, null);
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) return { constraints: undefined, error: BlobError.fromJSON(body, res.status) ?? BlobError.fromStatus(res.status) };
  return remember(route, { constraints: isConstraints(body) ? body.constraints : undefined }, res.headers.get("etag"));
};

const remember = (route: string, facts: RouteFacts, etag: string | null): RouteFacts => {
  cache.set(route, { ...facts, at: clock.now(), etag });
  return facts;
};

export const acceptOf = (constraints: ServedConstraints | undefined): string => constraints?.contentTypes?.join(",") ?? "";

export const deny = (file: File, constraints: ServedConstraints | undefined): BlobError | undefined => {
  if (constraints?.maxSize !== undefined && file.size > constraints.maxSize) {
    return new BlobError("too_large", { message: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(constraints.maxSize)} limit` });
  }
  if (!constraints?.contentTypes) return undefined;
  try {
    checkContentType(file.type || "application/octet-stream", undefined, constraints.contentTypes);
    return undefined;
  } catch (error) {
    return BlobError.is(error) ? error : undefined;
  }
};

export const useConstraints = (route: string, headers: HeadersProvider | undefined) => {
  const headersRef = useRef(headers);
  headersRef.current = headers;
  const routeRef = useRef(route);
  routeRef.current = route;

  const constraintsRef = useRef(cachedFacts(route)?.constraints);
  const [constraints, setConstraints] = useState(() => cachedFacts(route)?.constraints);

  const load = useCallback(async (): Promise<RouteFacts> => {
    const facts = await loadFacts(route, headersRef.current);
    if (routeRef.current === route) constraintsRef.current = facts.constraints;
    return facts;
  }, [route]);

  useEffect(() => {
    let alive = true;
    const hit = cachedFacts(route)?.constraints;
    constraintsRef.current = hit;
    setConstraints(hit);
    void load().then((facts) => {
      if (alive) setConstraints(facts.constraints);
    });
    return () => {
      alive = false;
    };
  }, [route, load]);

  return { constraintsRef, constraints, accept: acceptOf(constraints) };
};
