import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { version } from "../package.json";
import { attribution } from "./agent";
import { UsageError } from "./usage-error";

const remoteFile = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string(),
  contentType: z.string(),
  agent: z.string().nullable(),
  session: z.string().nullable(),
  commit: z.string().nullable(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
  verified: z.boolean(),
  private: z.boolean().default(false),
  url: z.string().nullable(),
});
const page = z.object({
  files: z.array(remoteFile),
  folders: z.array(z.string()),
  cursor: z.string().nullable(),
});
const statted = z.object({
  size: z.string().pipe(z.coerce.number()),
  contentType: z.string(),
  sha256: z.string().transform((etag) => etag.replaceAll('"', "")),
  updatedAt: z
    .string()
    .pipe(z.coerce.date())
    .transform((date) => date.toISOString()),
  expiresAt: z.string().nullable(),
  verified: z.enum(["true", "false"]).transform((verified) => verified === "true"),
  private: z
    .enum(["true", "false"])
    .nullable()
    .transform((hidden) => hidden === "true"),
  url: z.string().nullable(),
  agent: z.string().nullable(),
  session: z.string().nullable(),
  commit: z.string().nullable(),
});
const moved = z.object({ from: z.string(), to: z.string(), moved: z.number() });
const clearedFolder = z.object({ prefix: z.string(), deleted: z.number() });
const snapshot = z.object({
  name: z.string(),
  prefix: z.string(),
  files: z.number(),
  bytes: z.number(),
  createdAt: z.string(),
});
const snapshots = z.object({ snapshots: z.array(snapshot) });
const restored = z.object({
  name: z.string(),
  to: z.string(),
  restored: z.number(),
  deleted: z.number(),
});
const diff = z.object({
  from: z.string(),
  to: z.string().nullable(),
  added: z.array(z.object({ path: z.string(), sha256: z.string(), size: z.number() })),
  changed: z.array(
    z.object({ path: z.string(), fromSha256: z.string(), toSha256: z.string(), size: z.number() }),
  ),
  removed: z.array(z.object({ path: z.string(), sha256: z.string() })),
});
const json = z.json();
const fileEvent = z.object({
  id: z.string(),
  at: z.string(),
  op: z.enum(["put", "link", "fork", "move", "delete", "restore", "undelete", "expire", "tool"]),
  path: z.string().nullable(),
  from: z.string().nullable(),
  sha256: z.string().nullable(),
  size: z.number().nullable(),
  agent: z.string().nullable(),
  session: z.string().nullable(),
  commit: z.string().nullable(),
  name: z.string().nullable(),
  input: json.nullable(),
  output: json.nullable(),
  status: z.enum(["ok", "error"]).nullable(),
  durationMs: z.number().nullable(),
});
const history = z.object({ events: z.array(fileEvent), cursor: z.string().nullable() });
const kvItem = z.object({
  key: z.string(),
  value: json,
  version: z.number(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});
const kvPage = z.object({ items: z.array(kvItem), cursor: z.string().nullable() });
const linked = z.object({
  files: z.array(
    z.discriminatedUnion("status", [
      remoteFile.extend({ status: z.literal("linked") }),
      remoteFile.extend({ status: z.literal("unchanged") }),
      z.object({ path: z.string(), status: z.literal("missing"), current: z.string().nullable() }),
      z.object({ path: z.string(), status: z.literal("conflict"), current: z.string().nullable() }),
      z.object({ path: z.string(), status: z.literal("over_cap") }),
    ]),
  ),
});
const uploaded = remoteFile.extend({ status: z.enum(["uploaded", "unchanged"]) });
const restoredFile = remoteFile.extend({ status: z.literal("restored") });
const limits = z.object({
  key: z.object({
    id: z.string().nullable(),
    scoped: z.boolean(),
    prefix: z.string(),
    permissions: z.array(z.enum(["read", "write", "delete"])),
    expiresAt: z.string().nullable(),
  }),
  plan: z.string(),
  tier: z.string(),
  ownerUsedBytes: z.number().nullable(),
  ownerLimitBytes: z.number().nullable(),
  usedBytes: z.number(),
  files: z.number(),
  capBytes: z.number().nullable(),
  owner: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxCapBytes: z.number().nullable(),
  maxFileBytes: z.number(),
  maxMultipartBytes: z.number(),
  partBytes: z.number(),
  maxBatchFiles: z.number(),
  parallelUploads: z.number(),
});
const started = z.object({
  upload: z.string(),
  uploadId: z.string(),
  partBytes: z.number(),
  partUrls: z.array(z.string()).default([]),
});
const partUrlPage = z.object({ from: z.number(), partUrls: z.array(z.string()) });
const part = z.object({ partNumber: z.number(), etag: z.string() });
const forked = z.object({ from: z.string(), to: z.string(), copied: z.number() });
const signedLink = z.object({ url: z.string(), expiresAt: z.string() });
const claimLink = z.object({ url: z.string(), expiresAt: z.string(), message: z.string().optional() });
const issuedKey = z.object({ key: z.string() });
const keyInfo = z.object({
  id: z.string(),
  prefix: z.string(),
  permissions: z.array(z.enum(["read", "write", "delete"])),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  last4: z.string(),
  revoked: z.boolean(),
});
const keyList = z.object({ keys: z.array(keyInfo) });
const scopedKey = z.object({
  id: z.string(),
  key: z.string(),
  prefix: z.string(),
  permissions: z.array(z.enum(["read", "write", "delete"])),
  expiresAt: z.string().nullable(),
});
const usage = z.object({
  by: z.string(),
  rows: z.array(
    z.object({
      value: z.string().nullable(),
      files: z.number(),
      bytes: z.number(),
      writes: z.number(),
    }),
  ),
});
const received = z.object({ received: z.boolean() });
const problem = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryAfter: z.number().nullable(),
    requestId: z.string().optional(),
  }),
});

export type RemoteFile = z.infer<typeof remoteFile>;
export type Part = z.infer<typeof part>;
export type Wanted = { path: string; sha256: string; size: number };
export type Precondition = { kind: "none" } | { kind: "absent" } | { kind: "match"; etag: string };
export type Write = { precondition: Precondition; ttlSeconds: number | undefined };
/** `true` gives the file no public link, `false` makes it public, and `undefined` keeps what the file has. */
export type FileWrite = Write & { private?: boolean | undefined };
export type LinkEntry = Wanted & {
  ttlSeconds: number | undefined;
  private?: boolean | undefined;
  ifMatch?: string;
  ifNoneMatch?: true;
};
export type Permission = z.infer<typeof scopedKey>["permissions"][number];

export class ApiError extends Error {
  readonly detail: string;

  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly retryAfter: number | null = null,
    readonly status: number | null = null,
  ) {
    super(`${code}: ${message}${requestId === null ? "" : ` (request ${requestId})`}`);
    this.detail = message;
  }
}

const isLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/u.test(hostname);

/** The server URL. AGENTFS_API_URL is the name 0.0.2 read. The key goes only over HTTPS, or HTTP to localhost. */
export const baseUrl = () => {
  const url = (process.env.AGENTFS_URL || process.env.AGENTFS_API_URL || "https://agentfs.cloud").replace(/\/+$/u, "");
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed === null) throw new UsageError(`The API URL ${url} is not a valid URL.`);
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocalHost(parsed.hostname))) return url;
  throw new UsageError(
    `The API URL ${url} is not HTTPS. AgentFS only sends your key over HTTPS, or HTTP to localhost.`,
  );
};
export const configDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentfs",
);
export const keyFile = join(configDir, "key");
const legacyCredentials = join(configDir, "credentials.json");

let command: string | undefined;

export const setCommand = (name: string) => {
  command = name;
};

export const clientHeaders = (): Record<string, string> => ({
  "user-agent": `agentfs-cli/${version}`,
  ...(command === undefined ? {} : { "x-agentfs-command": command }),
});

const withClientHeaders = (init: RequestInit | undefined): RequestInit => {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(clientHeaders())) headers.set(name, value);
  return { ...init, headers };
};

const withIdempotencyKey = (init: RequestInit | undefined) => {
  const method = init?.method ?? "GET";
  if (method === "GET" || method === "HEAD") return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("idempotency-key")) headers.set("idempotency-key", crypto.randomUUID());
  return { ...init, headers };
};

const attempt = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl()}${path}`, init);
  if (response.ok) return response;
  const header = response.headers.get("x-request-id");
  const failure = problem.safeParse(await response.json().catch(() => null));
  if (!failure.success) throw new ApiError(String(response.status), response.statusText, header, null, response.status);
  const { code, message, retryAfter, requestId } = failure.data.error;
  throw new ApiError(
    code,
    `${message}${retryAfter === null ? "" : ` Retry in ${retryAfter}s.`}`,
    header ?? requestId ?? null,
    retryAfter,
    response.status,
  );
};

const send = async (path: string, init?: RequestInit) => {
  const keyed = withClientHeaders(withIdempotencyKey(init));
  return attempt(path, keyed).catch(async (error: Error) => {
    if (!(error instanceof ApiError && error.code === "idempotency_in_progress")) throw error;
    await new Promise((done) => setTimeout(done, (error.retryAfter ?? 1) * 1000));
    return attempt(path, keyed);
  });
};

export const putToUrl = async (url: string, body: Blob) => {
  const response = await fetch(url, { method: "PUT", body, headers: clientHeaders() });
  if (response.status === 403) return { kind: "forbidden" as const };
  if (!response.ok) throw new ApiError(String(response.status), response.statusText, null, null, response.status);
  const etag = response.headers.get("etag");
  if (etag === null) throw new ApiError("no_etag", "the storage service sent no ETag for the part");
  return { kind: "ok" as const, etag };
};

export const report = async (url: string, reason: string) =>
  received.parse(
    await (
      await send("/v1/reports", {
        method: "POST",
        body: JSON.stringify({ url, reason }),
        headers: { "content-type": "application/json" },
      })
    ).json(),
  );

export const saveKey = async (key: string) => {
  await mkdir(dirname(keyFile), { recursive: true });
  await writeFile(keyFile, key, { mode: 0o600 });
};

export type KeySource = "env" | "file";

export const findKey = async (): Promise<{ key: string; source: KeySource } | null> => {
  const fromEnv = process.env.AGENTFS_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, source: "env" };
  const saved = await readFile(keyFile, "utf8").catch(() => null);
  return saved === null ? null : { key: saved.trim(), source: "file" };
};

const loadKey = async (given?: { key: string; source: KeySource }) => {
  const found = given ?? (await findKey());
  if (found !== null) return found;
  if (await access(legacyCredentials).then(() => true, () => false)) {
    throw new UsageError(
      `found a 0.0.2 login in ${legacyCredentials}, which this version does not read, and no key. Signing up now would start a new empty account. Get a key for that account from the API keys page of the dashboard on https://agentfs.cloud, then run: agentfs login --key-stdin`,
    );
  }
  const { key } = issuedKey.parse(await (await send("/v1/signup", { method: "POST" })).json());
  await saveKey(key);
  process.stderr.write(`Signed up. Your key is in ${keyFile}\n`);
  return { key, source: "file" as const };
};

const guard = (precondition: Precondition): Record<string, string> => {
  switch (precondition.kind) {
    case "none":
      return {};
    case "absent":
      return { "if-none-match": "*" };
    case "match":
      return { "if-match": `"${precondition.etag}"` };
    default: {
      const _exhaustive: never = precondition;
      return _exhaustive;
    }
  }
};

const expiry = (ttlSeconds: number | undefined): Record<string, string> =>
  ttlSeconds === undefined ? {} : { "x-agentfs-ttl": String(ttlSeconds) };

const hiding = (hidden: boolean | undefined): Record<string, string> =>
  hidden === undefined ? {} : { "x-agentfs-private": String(hidden) };

const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const connect = async (given?: { key: string; source: KeySource }) => {
  const { key, source } = await loadKey(given);
  const headers = { authorization: `Bearer ${key}`, ...attribution() };
  const withJson = (method: string, body: string) => ({
    method,
    body,
    headers: { ...headers, "content-type": "application/json" },
  });
  const post = (path: string, body: string) => send(path, withJson("POST", body));
  const uploadPath = (upload: string, uploadId: string) =>
    `/v1/uploads/${upload}/${encodeURIComponent(uploadId)}`;
  const eventsPage = async (params: Record<string, string>) =>
    history.parse(
      await (await send(`/v1/events?${new URLSearchParams(params)}`, { headers })).json(),
    );
  const browse = async (prefix: string, delimiter = "", search = "") => {
    const files: RemoteFile[] = [];
    const folders: string[] = [];
    let cursor = "";
    do {
      const query = new URLSearchParams({
        prefix,
        cursor,
        ...(delimiter === "" ? {} : { delimiter }),
        ...(search === "" ? {} : { q: search }),
      });
      const next = page.parse(await (await send(`/v1/files?${query}`, { headers })).json());
      files.push(...next.files);
      folders.push(...next.folders);
      cursor = next.cursor ?? "";
    } while (cursor !== "");
    return { files, folders };
  };
  return {
    key,
    source,
    account: key.slice("afs_".length).split(".")[0] ?? "",
    browse,
    list: async (prefix: string, search = "") => (await browse(prefix, "", search)).files,
    stat: async (path: string): Promise<RemoteFile | null> => {
      const response = await send(`/v1/files/${segments(path)}`, { method: "HEAD", headers }).catch(
        (error: Error) => {
          if (error instanceof ApiError && error.code === "404") return null;
          throw error;
        },
      );
      if (response === null) return null;
      const header = (name: string) => response.headers.get(name);
      return {
        path,
        ...statted.parse({
          size: header("content-length"),
          contentType: header("content-type"),
          sha256: header("etag"),
          updatedAt: header("last-modified"),
          expiresAt: header("x-agentfs-expires-at"),
          verified: header("x-agentfs-verified"),
          private: header("x-agentfs-private"),
          url: header("x-agentfs-url"),
          agent: header("x-agentfs-agent"),
          session: header("x-agentfs-session"),
          commit: header("x-agentfs-commit"),
        }),
      };
    },
    link: async (files: LinkEntry[]) =>
      linked.parse(await (await post("/v1/files", JSON.stringify({ files }))).json()).files,
    upload: async (file: Wanted, body: Blob, { precondition, ttlSeconds, private: hidden }: FileWrite) => {
      const init = {
        method: "PUT",
        body,
        headers: {
          ...headers,
          ...guard(precondition),
          ...expiry(ttlSeconds),
          ...hiding(hidden),
          "x-sha256": file.sha256,
        },
      };
      return uploaded.parse(await (await send(`/v1/files/${segments(file.path)}`, init)).json());
    },
    startUpload: async ({ path, sha256, size }: Wanted, ttlSeconds: number | undefined) =>
      started.parse(
        await (
          await send("/v1/uploads", {
            method: "POST",
            body: JSON.stringify({ path, sha256, size, direct: true }),
            headers: { ...headers, ...expiry(ttlSeconds), "content-type": "application/json" },
          })
        ).json(),
      ),
    partUrls: async (upload: string, uploadId: string, from: number) =>
      partUrlPage.parse(
        await (
          await send(`${uploadPath(upload, uploadId)}/parts?${new URLSearchParams({ from: String(from) })}`, {
            headers,
          })
        ).json(),
      ),
    completeUpload: async (
      upload: string,
      uploadId: string,
      file: Wanted,
      parts: Part[],
      precondition: Precondition,
      hidden: boolean | undefined,
    ) =>
      uploaded.parse(
        await (
          await send(`${uploadPath(upload, uploadId)}/complete`, {
            method: "POST",
            body: JSON.stringify({ path: file.path, sha256: file.sha256, parts, private: hidden }),
            headers: { ...headers, ...guard(precondition), "content-type": "application/json" },
          })
        ).json(),
      ),
    sign: async (path: string, ttlSeconds: number | undefined) =>
      signedLink.parse(await (await post("/v1/files/sign", JSON.stringify({ path, ttlSeconds }))).json()),
    content: (path: string) => send(`/v1/content/${segments(path)}`, { headers }),
    remove: async (path: string, precondition: Precondition = { kind: "none" }) => {
      await send(`/v1/files/${segments(path)}`, {
        method: "DELETE",
        headers: { ...headers, ...guard(precondition) },
      });
    },
    move: async (from: string, to: string) =>
      moved.parse(await (await post("/v1/files/move", JSON.stringify({ from, to }))).json()),
    removeFolder: async (prefix: string) =>
      clearedFolder.parse(
        await (
          await send(`/v1/files?${new URLSearchParams({ prefix })}`, { method: "DELETE", headers })
        ).json(),
      ),
    snapshot: async (name: string, prefix: string) =>
      snapshot.parse(await (await post("/v1/snapshots", JSON.stringify({ name, prefix }))).json()),
    snapshots: async () =>
      snapshots.parse(await (await send("/v1/snapshots", { headers })).json()).snapshots,
    removeSnapshot: async (name: string) => {
      await send(`/v1/snapshots/${encodeURIComponent(name)}`, { method: "DELETE", headers });
    },
    restore: async (name: string, to: string) =>
      restored.parse(
        await (
          await post(
            `/v1/snapshots/${encodeURIComponent(name)}/restore`,
            JSON.stringify(to === "" ? {} : { to }),
          )
        ).json(),
      ),
    diff: async (from: string, to: string | undefined) => {
      const query = new URLSearchParams({ from, ...(to === undefined ? {} : { to }) });
      return diff.parse(await (await send(`/v1/diff?${query}`, { headers })).json());
    },
    events: async function* (filter: EventFilter) {
      let cursor = "";
      do {
        const next = await eventsPage({ ...filter, cursor });
        yield* next.events;
        cursor = next.cursor ?? "";
      } while (cursor !== "");
    },
    follow: async function* (filter: EventFilter) {
      const newest = await eventsPage({ ...filter, cursor: "" });
      yield* newest.events;
      let after = newest.events[0]?.id ?? "0";
      while (true) {
        const next = await eventsPage({ ...filter, after, wait: "30" });
        yield* next.events;
        after = next.cursor ?? after;
      }
    },
    kvSet: async (key: string, value: Json, { precondition, ttlSeconds }: Write) =>
      kvItem.parse(
        await (
          await send(`/v1/kv/${segments(key)}`, {
            method: "PUT",
            body: JSON.stringify(value),
            headers: {
              ...headers,
              ...guard(precondition),
              ...expiry(ttlSeconds),
              "content-type": "application/json",
            },
          })
        ).json(),
      ),
    kvGet: async (key: string) =>
      kvItem.parse(await (await send(`/v1/kv/${segments(key)}`, { headers })).json()),
    kvRemove: async (key: string, precondition: Precondition) => {
      await send(`/v1/kv/${segments(key)}`, {
        method: "DELETE",
        headers: { ...headers, ...guard(precondition) },
      });
    },
    kvList: async (prefix: string) => {
      const items: z.infer<typeof kvItem>[] = [];
      let cursor = "";
      do {
        const query = new URLSearchParams({ prefix, cursor });
        const next = kvPage.parse(await (await send(`/v1/kv?${query}`, { headers })).json());
        items.push(...next.items);
        cursor = next.cursor ?? "";
      } while (cursor !== "");
      return items;
    },
    logEvent: async (call: ToolCall) =>
      fileEvent.parse(await (await post("/v1/events", JSON.stringify({ op: "tool", ...call }))).json()),
    undelete: async (path: string) =>
      restoredFile.parse(await (await post("/v1/files/undelete", JSON.stringify({ path }))).json()),
    usage: async (by: string) =>
      usage.parse(await (await send(`/v1/usage?${new URLSearchParams({ by })}`, { headers })).json()),
    createKey: async (prefix: string, permissions: Permission[], ttlSeconds: number | undefined) =>
      scopedKey.parse(
        await (await post("/v1/keys", JSON.stringify({ prefix, permissions, ttlSeconds }))).json(),
      ),
    listKeys: async () => keyList.parse(await (await send("/v1/keys", { headers })).json()).keys,
    revokeKey: async (id: string) => {
      await send(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE", headers });
    },
    eventsAfter: (filter: EventFilter, after: string, wait: number) =>
      eventsPage({ ...filter, after, wait: String(wait) }),
    newestEventId: async (filter: EventFilter) =>
      (await eventsPage({ ...filter, cursor: "" })).events[0]?.id ?? "0",
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

export type FileEvent = z.infer<typeof history>["events"][number];
export type Json = z.infer<typeof json>;
export type ToolCall = {
  name: string;
  input?: Json;
  output?: Json;
  status: "ok" | "error";
  durationMs: number;
  startedAt?: string;
};
type EventFilter = { path: string; agent: string; session: string; op: string };

export type Api = Awaited<ReturnType<typeof connect>>;
