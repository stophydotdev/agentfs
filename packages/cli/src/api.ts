import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { attribution } from "./agent";

const remoteFile = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string(),
  contentType: z.string(),
  agent: z.string().nullable(),
  session: z.string().nullable(),
  commit: z.string().nullable(),
  updatedAt: z.string(),
  url: z.string(),
});
const page = z.object({ files: z.array(remoteFile), cursor: z.string().nullable() });
const linked = z.object({
  files: z.array(
    z.discriminatedUnion("status", [
      remoteFile.extend({ status: z.literal("linked") }),
      remoteFile.extend({ status: z.literal("unchanged") }),
      z.object({ path: z.string(), status: z.literal("missing") }),
      z.object({ path: z.string(), status: z.literal("over_cap") }),
    ]),
  ),
});
const uploaded = remoteFile.extend({ status: z.enum(["uploaded", "unchanged"]) });
const limits = z.object({
  plan: z.string(),
  usedBytes: z.number(),
  files: z.number(),
  capBytes: z.number(),
  owner: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxCapBytes: z.number(),
  maxFileBytes: z.number(),
  maxMultipartBytes: z.number(),
  partBytes: z.number(),
  maxBatchFiles: z.number(),
  parallelUploads: z.number(),
});
const started = z.object({ upload: z.string(), uploadId: z.string(), partBytes: z.number() });
const part = z.object({ partNumber: z.number(), etag: z.string() });
const forked = z.object({ from: z.string(), to: z.string(), copied: z.number() });
const claimLink = z.object({ url: z.string(), expiresAt: z.string() });
const issuedKey = z.object({ key: z.string() });
const problem = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryAfter: z.number().nullable() }),
});

export type RemoteFile = z.infer<typeof remoteFile>;
export type Part = z.infer<typeof part>;
export type Wanted = { path: string; sha256: string; size: number };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export const base = (process.env.AGENTFS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/u, "");
export const configDir = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "agentfs-next",
);
export const keyFile = join(configDir, "key");

const send = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${base}${path}`, init);
  if (response.ok) return response;
  const failure = problem.safeParse(await response.json().catch(() => null));
  if (!failure.success) throw new ApiError(String(response.status), response.statusText);
  const { code, message, retryAfter } = failure.data.error;
  throw new ApiError(code, `${message}${retryAfter === null ? "" : ` Retry in ${retryAfter}s.`}`);
};

export const saveKey = async (key: string) => {
  await mkdir(dirname(keyFile), { recursive: true });
  await writeFile(keyFile, key, { mode: 0o600 });
};

const loadKey = async () => {
  const fromEnv = process.env.AGENTFS_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, source: "env" as const };
  const saved = await readFile(keyFile, "utf8").catch(() => null);
  if (saved !== null) return { key: saved.trim(), source: "file" as const };
  const { key } = issuedKey.parse(await (await send("/v1/signup", { method: "POST" })).json());
  await saveKey(key);
  process.stderr.write(`Signed up. Your key is in ${keyFile}\n`);
  return { key, source: "file" as const };
};

const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const connect = async () => {
  const { key, source } = await loadKey();
  const headers = { authorization: `Bearer ${key}`, ...attribution() };
  const withJson = (method: string, body: string) => ({
    method,
    body,
    headers: { ...headers, "content-type": "application/json" },
  });
  const post = (path: string, body: string) => send(path, withJson("POST", body));
  const uploadPath = (upload: string, uploadId: string) =>
    `/v1/uploads/${upload}/${encodeURIComponent(uploadId)}`;
  return {
    key,
    source,
    account: key.slice("afs_".length).split(".")[0] ?? "",
    list: async (prefix: string) => {
      const files: RemoteFile[] = [];
      let cursor = "";
      do {
        const query = new URLSearchParams({ prefix, cursor });
        const next = page.parse(await (await send(`/v1/files?${query}`, { headers })).json());
        files.push(...next.files);
        cursor = next.cursor ?? "";
      } while (cursor !== "");
      return files;
    },
    link: async (files: Wanted[]) =>
      linked.parse(await (await post("/v1/files", JSON.stringify({ files }))).json()).files,
    upload: async (file: Wanted, body: Blob) => {
      const init = { method: "PUT", body, headers: { ...headers, "x-sha256": file.sha256 } };
      return uploaded.parse(await (await send(`/v1/files/${segments(file.path)}`, init)).json());
    },
    startUpload: async (file: Wanted) =>
      started.parse(await (await post("/v1/uploads", JSON.stringify(file))).json()),
    uploadPart: async (upload: string, uploadId: string, partNumber: number, body: Blob) =>
      part.parse(
        await (
          await send(`${uploadPath(upload, uploadId)}/${partNumber}`, { method: "PUT", body, headers })
        ).json(),
      ),
    completeUpload: async (upload: string, uploadId: string, file: Wanted, parts: Part[]) =>
      uploaded.parse(
        await (
          await post(
            `${uploadPath(upload, uploadId)}/complete`,
            JSON.stringify({ path: file.path, sha256: file.sha256, parts }),
          )
        ).json(),
      ),
    remove: async (path: string) => {
      await send(`/v1/files/${segments(path)}`, { method: "DELETE", headers });
    },
    fork: async (from: string, to: string) =>
      forked.parse(await (await post("/v1/fork", JSON.stringify({ from, to }))).json()),
    limits: async () => limits.parse(await (await send("/v1/limits", { headers })).json()),
    setCap: async (capBytes: number) =>
      limits.parse(await (await send("/v1/limits", withJson("PUT", JSON.stringify({ capBytes })))).json()),
    feedback: async (message: string) => {
      await post("/v1/feedback", JSON.stringify({ message }));
    },
    claim: async () => claimLink.parse(await (await post("/v1/claim", "{}")).json()),
    rotateKey: async () => issuedKey.parse(await (await post("/v1/keys/rotate", "{}")).json()).key,
  };
};

export type Api = Awaited<ReturnType<typeof connect>>;
