import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import type { Api, RemoteFile } from "./api";
import { collect } from "./collect";
import { inParallel, sha256Of } from "./local";
import { uploadInParts } from "./parts";

const BATCH = 1000;

export type PutOutcome =
  | { kind: "uploaded" | "linked" | "unchanged"; file: RemoteFile }
  | { kind: "failed"; path: string; reason: string };

export const put = async (api: Api, paths: string[], to: string, includeSecrets: boolean) => {
  const { locals, skipped } = await collect(paths, to, includeSecrets);
  const [{ maxFileBytes }, hashed] = await Promise.all([
    api.limits(),
    inParallel(locals, async (local) => ({
      ...local,
      sha256: await sha256Of(local.file),
      size: (await stat(local.file)).size,
    })),
  ]);
  const batches = Array.from({ length: Math.ceil(hashed.length / BATCH) }, (_, index) =>
    hashed.slice(index * BATCH, (index + 1) * BATCH),
  );
  const answers = await Promise.all(
    batches.map((batch) => api.link(batch.map(({ path, sha256, size }) => ({ path, sha256, size })))),
  );
  const byPath = new Map(answers.flat().map((answer) => [answer.path, answer]));
  const outcomes = await inParallel(hashed, async (local): Promise<PutOutcome> => {
    const answer = byPath.get(local.path);
    if (answer?.status === "linked" || answer?.status === "unchanged") {
      return { kind: answer.status, file: answer };
    }
    if (answer?.status === "over_cap") {
      return { kind: "failed", path: local.path, reason: "storage_cap_reached: see agentfs limits" };
    }
    try {
      const file =
        local.size > maxFileBytes
          ? await uploadInParts(api, local)
          : await api.upload(local, await openAsBlob(local.file));
      return { kind: file.status, file };
    } catch (error) {
      return {
        kind: "failed",
        path: local.path,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return { outcomes, skipped: skipped.map((local) => local.path) };
};
