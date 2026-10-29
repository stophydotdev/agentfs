import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { Api } from "./api";
import { inParallel, sha256Of } from "./local";

export type PullOutcome =
  | { kind: "downloaded" | "unchanged"; path: string; target: string }
  | { kind: "failed"; path: string; reason: string };

export const pull = async (api: Api, folder: string, into: string) => {
  const prefix = `${folder.replace(/^\/+|\/+$/gu, "")}/`;
  const root = resolve(into, basename(prefix));
  return inParallel(await api.list(prefix), async (file): Promise<PullOutcome> => {
    const target = resolve(root, ...file.path.slice(prefix.length).split("/"));
    if (relative(root, target).startsWith("..")) {
      return { kind: "failed", path: file.path, reason: "the path leaves the target folder" };
    }
    try {
      if ((await sha256Of(target).catch(() => null)) === file.sha256) {
        return { kind: "unchanged", path: file.path, target };
      }
      const response = await fetch(file.url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error("the downloaded bytes do not match the file's sha256");
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return { kind: "downloaded", path: file.path, target };
    } catch (error) {
      return { kind: "failed", path: file.path, reason: error instanceof Error ? error.message : String(error) };
    }
  });
};
