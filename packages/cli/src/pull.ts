import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { type Api, type RemoteFile, clientHeaders } from "./api";
import { inParallel, sha256Of } from "./local";

export type PullOutcome =
  | { kind: "downloaded" | "unchanged"; path: string; target: string; size: number }
  | { kind: "failed"; path: string; reason: string };

export const fetchVerified = async (api: Api, file: RemoteFile) => {
  const response =
    file.url === null ? await api.content(file.path) : await fetch(file.url, { headers: clientHeaders() });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new Error("the downloaded bytes do not match the file's sha256");
  }
  return bytes;
};

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
        return { kind: "unchanged", path: file.path, target, size: file.size };
      }
      const bytes = await fetchVerified(api, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return { kind: "downloaded", path: file.path, target, size: file.size };
    } catch (error) {
      return { kind: "failed", path: file.path, reason: error instanceof Error ? error.message : String(error) };
    }
  });
};
