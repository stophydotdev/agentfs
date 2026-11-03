import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { type Api, ApiError, type LinkEntry, type Precondition, type RemoteFile } from "./api";
import { type Local, collect } from "./collect";
import { inParallel, sha256Of } from "./local";
import { uploadInParts } from "./parts";
import { formatBytes } from "./units";

const BATCH = 1000;

/** A file above this many bytes goes up in parts. The server refuses a direct upload at or below it, and it is the same on every plan. */
const PARTS_ABOVE_BYTES = 90 * 1024 * 1024;

export type PutOutcome =
  | { kind: "uploaded" | "linked" | "unchanged"; file: RemoteFile }
  | { kind: "conflict"; path: string }
  | { kind: "failed"; path: string; reason: string };

type WriteOptions = {
  force: boolean;
  ttlSeconds: number | undefined;
  expected?: Map<string, string | null>;
};

type PutOptions = WriteOptions & { to: string; includeSecrets: boolean };

const expectation = (force: boolean, current: string | null): Precondition => {
  if (force) return { kind: "none" };
  return current === null ? { kind: "absent" } : { kind: "match", etag: current };
};

const linkAll = async (api: Api, entries: LinkEntry[]) => {
  const batches = Array.from({ length: Math.ceil(entries.length / BATCH) }, (_, index) =>
    entries.slice(index * BATCH, (index + 1) * BATCH),
  );
  return (await Promise.all(batches.map((batch) => api.link(batch)))).flat();
};

export const putLocals = async (
  api: Api,
  locals: Local[],
  { force, ttlSeconds, expected }: WriteOptions,
) => {
  const [{ maxFileBytes, plan }, hashed] = await Promise.all([
    api.limits(),
    inParallel(locals, async (local) => ({
      ...local,
      sha256: await sha256Of(local.file),
      size: (await stat(local.file)).size,
    })),
  ]);
  const entries = hashed.map(({ path, sha256, size }): LinkEntry => ({ path, sha256, size, ttlSeconds }));
  const guardOf = (path: string): Pick<LinkEntry, "ifMatch" | "ifNoneMatch"> => {
    if (expected === undefined) return force ? {} : { ifNoneMatch: true };
    const sha256 = expected.get(path) ?? null;
    return sha256 === null ? { ifNoneMatch: true } : { ifMatch: sha256 };
  };
  const first = await linkAll(
    api,
    entries.map((entry): LinkEntry => ({ ...entry, ...guardOf(entry.path) })),
  );
  const retries = first.flatMap((answer): LinkEntry[] => {
    if (expected !== undefined || answer.status !== "conflict" || answer.current === null) return [];
    const entry = entries.find(({ path }) => path === answer.path);
    return entry === undefined ? [] : [{ ...entry, ifMatch: answer.current }];
  });
  const byPath = new Map([...first, ...(await linkAll(api, retries))].map((answer) => [answer.path, answer]));
  const outcomes = await inParallel(hashed, async (local): Promise<PutOutcome> => {
    const answer = byPath.get(local.path);
    if (answer?.status === "linked" || answer?.status === "unchanged") {
      return { kind: answer.status, file: answer };
    }
    if (answer?.status === "conflict") return { kind: "conflict", path: local.path };
    if (answer?.status === "over_cap") {
      return { kind: "failed", path: local.path, reason: "storage_cap_reached: see agentfs limits" };
    }
    if (local.size > maxFileBytes) {
      const reason = `file_too_large: ${formatBytes(local.size)} is more than the ${formatBytes(maxFileBytes)} one file can be on the ${plan} plan. See agentfs limits.`;
      return { kind: "failed", path: local.path, reason };
    }
    try {
      const write = {
        precondition:
          expected === undefined
            ? expectation(force, answer?.status === "missing" ? answer.current : null)
            : expectation(false, expected.get(local.path) ?? null),
        ttlSeconds,
      };
      const file =
        local.size > PARTS_ABOVE_BYTES
          ? await uploadInParts(api, local, write)
          : await api.upload(local, await openAsBlob(local.file), write);
      return { kind: file.status, file };
    } catch (error) {
      if (error instanceof ApiError && error.code === "precondition_failed") {
        return { kind: "conflict", path: local.path };
      }
      return {
        kind: "failed",
        path: local.path,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return outcomes;
};

export const put = async (api: Api, paths: string[], { to, includeSecrets, ...options }: PutOptions) => {
  const { locals, skipped } = await collect(paths, to, includeSecrets);
  return { outcomes: await putLocals(api, locals, options), skipped: skipped.map((local) => local.path) };
};
