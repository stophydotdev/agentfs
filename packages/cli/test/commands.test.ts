import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runner, start } from "./cli";

type Seen = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
};

const seen: Seen[] = [];
const script = new Map<string, () => Response | Promise<Response>>();

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body: await request.text(),
    });
    const answer = script.get(`${request.method} ${url.pathname}`);
    if (answer !== undefined) return answer();
    const error = { code: "not_found", message: "nothing here", retryAfter: null };
    return Response.json({ error }, { status: 404 });
  },
});
afterAll(() => server.stop());

const config = await mkdtemp(join(tmpdir(), "agentfs-config-"));
const agentfs = runner(server, config);
script.set("POST /v1/signup", () => Response.json({ key: "afs_TestTestTestTestTestTestTestTest" }, { status: 201 }));

beforeEach(() => {
  seen.length = 0;
});

const file = (path: string, agent: string | null) => ({
  path,
  size: 2048,
  sha256: "abc",
  contentType: "text/plain",
  agent,
  session: null,
  commit: null,
  updatedAt: "2026-10-29T00:00:00.000Z",
  expiresAt: null,
  verified: true,
  url: `https://files.test/${path}`,
});

const HEAD = {
  "content-length": "1",
  "content-type": "text/plain",
  etag: '"abc"',
  "last-modified": "Thu, 29 Oct 2026 00:00:00 GMT",
  "x-agentfs-verified": "true",
  "x-agentfs-url": "https://files.test/a.txt",
};

const event = (id: string, op: string, path: string, from: string | null) => ({
  id,
  at: `2026-10-29T00:00:0${id}.000Z`,
  op,
  path,
  from,
  sha256: null,
  size: null,
  agent: "codex",
  session: null,
  commit: null,
  name: null,
  input: null,
  output: null,
  status: null,
  durationMs: null,
});

const toolEvent = {
  ...event("7", "tool", "", null),
  path: null,
  name: "search",
  input: { q: "cats" },
  output: { hits: 3 },
  status: "ok",
  durationMs: 120,
};

const item = (value: unknown) => ({
  key: "lock",
  value,
  version: 3,
  updatedAt: "2026-10-29T00:00:00.000Z",
  expiresAt: null,
});

const lastRequest = () => seen[seen.length - 1];

test("ls lists one level with folders first", async () => {
  script.set("GET /v1/files", () =>
    Response.json({
      files: [file("reports/a.txt", "claude-code"), file("reports/b.txt", "codex")],
      folders: ["reports/2026/"],
      cursor: null,
    }),
  );
  const result = await agentfs("ls", "reports", "--by", "codex");
  expect(result.stdout).toBe(
    "reports/2026/\nreports/b.txt\t2 KB\tcodex\t-\thttps://files.test/reports/b.txt\n",
  );
  expect(lastRequest()?.query.get("prefix")).toBe("reports/");
  expect(lastRequest()?.query.get("delimiter")).toBe("/");
});

test("ls -r lists everything below the prefix without a delimiter", async () => {
  script.set("GET /v1/files", () =>
    Response.json({
      files: [{ ...file("reports/2026/c.txt", null), verified: false }],
      folders: [],
      cursor: null,
    }),
  );
  const json = await agentfs("ls", "-r", "reports", "--json");
  expect(JSON.parse(json.stdout).verified).toBe(false);
  const piped = await agentfs.piped("ls", "-r", "reports");
  expect(JSON.parse(piped.stdout)).toEqual({
    path: "reports/2026/c.txt",
    size: 2048,
    url: "https://files.test/reports/2026/c.txt",
  });
  const result = await agentfs("ls", "-r", "reports");
  expect(result.stdout).toBe("reports/2026/c.txt\t2 KB\t-\t-\thttps://files.test/reports/2026/c.txt\n");
  expect(lastRequest()?.query.get("prefix")).toBe("reports");
  expect(lastRequest()?.query.has("delimiter")).toBe(false);
});

test("stat prints what the HEAD headers say about a file", async () => {
  script.set("HEAD /v1/files/docs/a%20b.txt", () =>
    new Response(null, {
      headers: {
        "content-length": "12",
        "content-type": "text/plain",
        etag: '"deadbeef"',
        "last-modified": "Thu, 29 Oct 2026 10:30:00 GMT",
        "x-agentfs-url": "https://files.test/docs/a%20b.txt",
        "x-agentfs-expires-at": "2026-10-30T10:30:00.000Z",
        "x-agentfs-verified": "false",
        "x-agentfs-agent": "claude-code",
        "x-agentfs-commit": "7eec9bf",
      },
    }),
  );
  const result = await agentfs("stat", "docs/a b.txt", "--json");
  expect(JSON.parse(result.stdout)).toEqual({
    path: "docs/a b.txt",
    size: 12,
    contentType: "text/plain",
    sha256: "deadbeef",
    updatedAt: "2026-10-29T10:30:00.000Z",
    expiresAt: "2026-10-30T10:30:00.000Z",
    verified: false,
    private: false,
    url: "https://files.test/docs/a%20b.txt",
    agent: "claude-code",
    session: null,
    commit: "7eec9bf",
  });
});

test("stat of a missing file fails with not_found", async () => {
  const result = await agentfs("stat", "nothing.txt");
  expect(result.stderr).toBe("error: not_found: no file at nothing.txt\n");
  expect(result.code).toBe(1);
});

test("stat of a bad path shows the server's error, not a blank 400", async () => {
  script.set("HEAD /v1/files/a/b.txt", () => new Response(null, { status: 400 }));
  script.set("GET /v1/files/a/b.txt", () =>
    Response.json(
      { error: { code: "invalid_path", message: "Bad path.", retryAfter: null, requestId: "req_p" } },
      { status: 400 },
    ),
  );
  const result = await agentfs("stat", "a/b.txt");
  expect(result.stderr).toBe("error: invalid_path: Bad path. (request req_p)\n");
  expect(result.code).toBe(1);
});

test("mv moves a file as it is and adds the slashes for a folder that exists", async () => {
  script.set("HEAD /v1/files/a.txt", () => new Response(null, { headers: HEAD }));
  script.set("POST /v1/files/move", () => Response.json({ from: "x", to: "y", moved: 1 }));
  await agentfs("mv", "a.txt", "b.txt");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ from: "a.txt", to: "b.txt" });

  script.set("GET /v1/files", () =>
    Response.json({ files: [file("docs/a.txt", null)], folders: [], cursor: null }),
  );
  const folder = await agentfs("mv", "docs", "archive", "--yes");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ from: "docs/", to: "archive/" });
  expect(folder.stdout).toBe("x -> y (1 files)\n");
});

test("rm -r deletes everything under a folder and refuses the whole account", async () => {
  script.set("DELETE /v1/files", () => Response.json({ prefix: "old/", deleted: 3 }));
  const result = await agentfs("rm", "-r", "old", "--yes");
  expect(result.stdout).toBe("3 files deleted from old/\n");
  expect(lastRequest()?.query.get("prefix")).toBe("old/");

  seen.length = 0;
  const refused = await agentfs("rm", "-r", "/");
  expect(refused.stderr).toBe("error: rm -r needs a folder\n");
  expect(seen).toEqual([]);
});

test("snapshot creates, lists and removes snapshots", async () => {
  const entry = { name: "before", prefix: "reports/", files: 4, bytes: 2048, createdAt: "2026-10-29T00:00:00.000Z" };
  script.set("POST /v1/snapshots", () => Response.json(entry, { status: 201 }));
  script.set("GET /v1/snapshots", () => Response.json({ snapshots: [entry] }));
  script.set("DELETE /v1/snapshots/before", () => new Response(null, { status: 204 }));

  const created = await agentfs("snapshot", "before", "reports");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ name: "before", prefix: "reports/" });
  expect(created.stdout).toBe("before: 4 files, 2 KB from reports/\n");

  const listed = await agentfs("snapshot", "ls", "--json");
  expect(JSON.parse(listed.stdout)).toEqual(entry);

  const removed = await agentfs("snapshot", "rm", "before");
  expect(removed.stdout).toBe("before\n");
  expect(lastRequest()?.method).toBe("DELETE");
});

test("restore sends the folder only when --to is given", async () => {
  script.set("POST /v1/snapshots/before/restore", () =>
    Response.json({ name: "before", to: "reports/", restored: 4, deleted: 1 }),
  );
  const result = await agentfs("restore", "before", "--to", "reports", "--yes");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ to: "reports/" });
  expect(result.stdout).toBe("before: 4 files restored, 1 deleted in reports/\n");

  await agentfs("restore", "before", "--yes");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({});
});

test("diff prints added, changed and removed paths and compares with now for one name", async () => {
  script.set("GET /v1/diff", () =>
    Response.json({
      from: "v1",
      to: null,
      added: [{ path: "new.txt", sha256: "a", size: 1 }],
      changed: [{ path: "edit.txt", fromSha256: "b", toSha256: "c", size: 2 }],
      removed: [{ path: "gone.txt", sha256: "d" }],
    }),
  );
  const result = await agentfs("diff", "v1");
  expect(result.stdout).toBe("added\tnew.txt\nchanged\tedit.txt\nremoved\tgone.txt\n");
  expect(lastRequest()?.query.get("from")).toBe("v1");
  expect(lastRequest()?.query.has("to")).toBe(false);

  await agentfs("diff", "v1", "v2");
  expect(lastRequest()?.query.get("to")).toBe("v2");
});

test("timeline follows the cursor and prints events newest first", async () => {
  script.set("GET /v1/events", () =>
    lastRequest()?.query.get("cursor") === ""
      ? Response.json({ events: [event("3", "move", "b.txt", "a.txt")], cursor: "next" })
      : Response.json({ events: [event("1", "put", "a.txt", null)], cursor: null }),
  );
  const result = await agentfs("timeline", "a.txt", "--by", "codex", "--session", "s1");
  expect(result.stdout).toBe(
    "2026-10-29T00:00:03.000Z\tmove\ta.txt -> b.txt\tcodex\t-\t-\n2026-10-29T00:00:01.000Z\tput\ta.txt\tcodex\t-\t-\n",
  );
  expect(seen.map(({ query }) => query.get("cursor"))).toEqual(["", "next"]);
  expect(seen[0]?.query.get("path")).toBe("a.txt");
  expect(seen[0]?.query.get("agent")).toBe("codex");
  expect(seen[0]?.query.get("session")).toBe("s1");
});

test("timeline with no filter sends no empty filter, which the server would match against nothing", async () => {
  script.set("GET /v1/events", () => Response.json({ events: [event("1", "put", "a.txt", null)], cursor: null }));
  const result = await agentfs("timeline");
  expect(result.stdout).toBe("2026-10-29T00:00:01.000Z\tput\ta.txt\tcodex\t-\t-\n");
  const query = seen.find((request) => request.path === "/v1/events")?.query;
  expect(query?.toString()).toBe("cursor=");
});

test("a scoped key is made with the folder, permissions and lifetime asked for", async () => {
  const made = {
    id: "key_1",
    key: "afs_ScopedScopedScopedScopedScopedSc",
    prefix: "reports/",
    permissions: ["read", "write"],
    expiresAt: "2026-10-29T01:00:00.000Z",
  };
  script.set("POST /v1/keys", () => Response.json(made, { status: 201 }));
  const result = await agentfs("key", "create", "--prefix", "reports", "--write", "--read", "--ttl", "1h");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({
    prefix: "reports/",
    permissions: ["read", "write"],
    ttlSeconds: 3600,
  });
  expect(result.stdout).toBe("afs_ScopedScopedScopedScopedScopedSc\n");

  const json = await agentfs("key", "create", "--read", "--json");
  expect(JSON.parse(json.stdout)).toEqual(made);

  const refused = await agentfs("key", "create", "--prefix", "reports");
  expect(refused.stderr).toBe("error: use at least one of --read, --write, --delete\n");
  expect(refused.code).toBe(2);
});

test("undelete brings a file back and an error shows its request id", async () => {
  script.set("POST /v1/files/undelete", () =>
    Response.json({ ...file("docs/a.txt", null), status: "restored" }),
  );
  const result = await agentfs("undelete", "docs/a.txt");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ path: "docs/a.txt" });
  expect(result.stdout).toBe("https://files.test/docs/a.txt\n");

  const error = { code: "file_exists", message: "a file is at that path", retryAfter: null, requestId: "req_9" };
  script.set("POST /v1/files/undelete", () => Response.json({ error }, { status: 409 }));
  const taken = await agentfs("undelete", "docs/a.txt");
  expect(taken.stderr).toBe("error: file_exists: a file is at that path (request req_9)\n");
  expect(taken.code).toBe(1);
});

test("a failed HEAD shows the request id from the header", async () => {
  script.set("HEAD /v1/files/boom.txt", () =>
    new Response(null, { status: 500, headers: { "x-request-id": "req_h" } }),
  );
  const result = await agentfs("stat", "boom.txt");
  expect(result.stderr).toBe("error: 500: Internal Server Error (request req_h)\n");
});

test("usage prints a row per label and defaults to agent", async () => {
  script.set("GET /v1/usage", () =>
    Response.json({
      by: "agent",
      rows: [
        { value: "codex", files: 3, bytes: 2048, writes: 7 },
        { value: null, files: 1, bytes: 10, writes: 0 },
      ],
    }),
  );
  const result = await agentfs("usage");
  expect(result.stdout).toBe("codex\t3\t2 KB\t7 writes\n-\t1\t10 B\t0 writes\n");
  expect(lastRequest()?.query.get("by")).toBe("agent");

  await agentfs("usage", "--by", "commit");
  expect(lastRequest()?.query.get("by")).toBe("commit");

  const refused = await agentfs("usage", "--by", "color");
  expect(refused.stderr).toBe("error: use --by agent, session or commit\n");
});

test("timeline --follow prints the newest page, then long-polls for what comes after", async () => {
  const held = new Promise<void>((arrived) => {
    script.set("GET /v1/events", () => {
      const after = lastRequest()?.query.get("after") ?? null;
      if (after === null) return Response.json({ events: [event("5", "put", "b.txt", null), event("4", "put", "a.txt", null)], cursor: "3" });
      if (after === "5") return Response.json({ events: [event("6", "delete", "a.txt", null)], cursor: "6" });
      arrived();
      return new Promise<Response>(() => {});
    });
  });
  const run = start(server, config, ["timeline", "--follow"]);
  const reader = run.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (out.split("\n").length < 4) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  await held;
  run.kill();
  expect(out.split("\n").map((line) => line.split("\t")[1])).toEqual(["put", "put", "delete", undefined]);
  expect(out.split("\n").map((line) => line.split("\t")[2])).toEqual(["b.txt", "a.txt", "a.txt", undefined]);
  const polls = seen.filter(({ query }) => query.has("after")).map(({ query }) => [query.get("after"), query.get("wait")]);
  expect(polls).toEqual([["5", "30"], ["6", "30"]]);
});

test("run pulls the inputs, runs the command, and puts the outputs even when it fails", async () => {
  const work = await mkdtemp(join(tmpdir(), "agentfs-run-"));
  const sha256 = new Bun.CryptoHasher("sha256").update("alpha").digest("hex");
  script.set("GET /v1/files", () =>
    Response.json({
      files: [{ ...file("data/a.txt", null), sha256, url: new URL("/blob/a.txt", server.url).href }],
      folders: [],
      cursor: null,
    }),
  );
  script.set("GET /blob/a.txt", () => new Response("alpha"));
  script.set("GET /v1/limits", () =>
    Response.json({
      account: "acct",
      key: { id: "key_1", scoped: false, prefix: "", permissions: ["read", "write", "delete"], expiresAt: null },
      plan: "free",
      tier: "unclaimed",
      ownerUsedBytes: null,
      ownerLimitBytes: null,
      usedBytes: 0,
      files: 0,
      capBytes: 1e10,
      owner: null,
      expiresAt: null,
      maxCapBytes: 1e10,
      maxFileBytes: 1e9,
      maxMultipartBytes: 1e12,
      partBytes: 1e8,
      maxBatchFiles: 1000,
      parallelUploads: 32,
    }),
  );
  script.set("POST /v1/files", () =>
    Response.json({ files: [{ path: "out/b.txt", status: "missing", current: null }] }),
  );
  script.set("PUT /v1/files/out/b.txt", () =>
    Response.json({ ...file("out/b.txt", null), status: "uploaded" }),
  );

  const inWork = runner(server, config, work);
  const result = await inWork(
    "run", "--in", "data", "--out", "out", "--",
    "sh", "-c", "mkdir -p out; tr a-z A-Z < data/a.txt > out/b.txt; echo ran; exit 3",
  );
  expect(result.code).toBe(3);
  expect(result.stdout).toBe("ran\nhttps://files.test/out/b.txt\n");
  expect(await readFile(join(work, "data", "a.txt"), "utf8")).toBe("alpha");
  expect(seen.find(({ method, path }) => method === "PUT" && path === "/v1/files/out/b.txt")?.body).toBe("ALPHA");
});

test("report needs no key and sends the url and the reason", async () => {
  script.set("POST /v1/reports", () => Response.json({ received: true }, { status: 201 }));
  const fresh = await mkdtemp(join(tmpdir(), "agentfs-config-"));
  const result = await runner(server, fresh)("report", "https://files.test/x", "it", "is", "phishing");
  expect(result.stdout).toBe("received\n");
  expect(seen.map(({ path }) => path)).toEqual(["/v1/reports"]);
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ url: "https://files.test/x", reason: "it is phishing" });
});

test("an expired key points to the key file", async () => {
  const error = { code: "key_expired", message: "the key expired", retryAfter: null, requestId: "req_k" };
  script.set("GET /v1/limits", () => Response.json({ error }, { status: 401 }));
  const result = await agentfs("limits");
  expect(result.stderr).toBe(
    `error: key_expired: the key expired (request req_k)\nIf this account expired, delete ${join(config, "agentfs", "key")} and run again to sign up.\n`,
  );
});

test("kv set stores JSON, falls back to a string, reads stdin and sends the preconditions", async () => {
  script.set("PUT /v1/kv/lock", () => Response.json(item(1)));
  const stored = await agentfs("kv", "set", "lock", '{"owner":"codex"}');
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ owner: "codex" });
  expect(stored.stdout).toBe("lock\tv3\n");

  await agentfs("kv", "set", "lock", "hello");
  expect(JSON.parse(lastRequest()?.body ?? "")).toBe("hello");

  await agentfs.stdin("from stdin\n", "kv", "set", "lock", "-");
  expect(JSON.parse(lastRequest()?.body ?? "")).toBe("from stdin");

  await agentfs("kv", "set", "lock", "1", "--if-version", "2", "--ttl", "1h");
  expect(lastRequest()?.headers.get("if-match")).toBe('"2"');
  expect(lastRequest()?.headers.get("x-agentfs-ttl")).toBe("3600");

  await agentfs("kv", "set", "lock", "1", "--create-only");
  expect(lastRequest()?.headers.get("if-none-match")).toBe("*");

  const both = await agentfs("kv", "set", "lock", "1", "--create-only", "--if-version", "2");
  expect(both.stderr).toBe("error: use --create-only or --if-version, not both\n");
});

test("kv get prints the value as JSON, or the whole item with --json", async () => {
  script.set("GET /v1/kv/team/notes", () => Response.json({ ...item({ todo: ["a"] }), key: "team/notes" }));
  const result = await agentfs("kv", "get", "team/notes");
  expect(result.stdout).toBe('{"todo":["a"]}\n');
  const json = await agentfs("kv", "get", "team/notes", "--json");
  expect(JSON.parse(json.stdout)).toEqual({ ...item({ todo: ["a"] }), key: "team/notes" });
});

test("kv rm deletes a key and sends the version it expects", async () => {
  script.set("DELETE /v1/kv/lock", () => new Response(null, { status: 204 }));
  const result = await agentfs("kv", "rm", "lock", "--if-version", "3");
  expect(result.stdout).toBe("lock\n");
  expect(lastRequest()?.headers.get("if-match")).toBe('"3"');
});

test("kv ls lists keys under a prefix with their versions and values", async () => {
  script.set("GET /v1/kv", () =>
    Response.json({ items: [{ ...item({ x: 1 }), key: "team/a" }], cursor: null }),
  );
  const result = await agentfs("kv", "ls", "team/");
  expect(result.stdout).toBe('team/a\tv3\t{"x":1}\n');
  expect(lastRequest()?.query.get("prefix")).toBe("team/");
});

test("log records one tool call with the input, output, status and duration", async () => {
  script.set("POST /v1/events", () => Response.json(toolEvent, { status: 201 }));
  const result = await agentfs(
    "log", "search", "--input", '{"q":"cats"}', "--output", "no results", "--status", "error", "--duration", "250",
  );
  expect(result.stdout).toBe("7\n");
  const { startedAt, ...body } = JSON.parse(lastRequest()?.body ?? "");
  expect(body).toEqual({
    op: "tool",
    name: "search",
    input: { q: "cats" },
    output: "no results",
    status: "error",
    durationMs: 250,
  });
  expect(Date.now() - Date.parse(startedAt)).toBeGreaterThanOrEqual(250);
});

test("timeline shows a tool call as tool, name, status and duration, and filters by op", async () => {
  script.set("GET /v1/events", () => Response.json({ events: [toolEvent], cursor: null }));
  const result = await agentfs("timeline", "--op", "tool");
  expect(result.stdout).toBe("2026-10-29T00:00:07.000Z\ttool search ok 120ms\tcodex\t-\t-\n");
  expect(lastRequest()?.query.get("op")).toBe("tool");
});

test("a command with --help prints only its own usage lines, and plain --help prints them all", async () => {
  const help = await agentfs("kv", "--help");
  const commands = help.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("agentfs"))
    .map((line) => line.trim().split(/\s+/u).slice(0, 3).join(" "));
  expect(help.code).toBe(0);
  expect(commands).toEqual(["agentfs kv get", "agentfs kv set", "agentfs kv rm", "agentfs kv ls"]);
  expect(help.stdout).toContain("[--if-version n] [--create-only]");

  const full = await agentfs("--help");
  expect(full.stdout).toContain(help.stdout.trimEnd());
  expect(full.stdout).toContain("agentfs put");
  expect(help.stdout).not.toContain("agentfs put");
});

type KeyInfo = { id: string | null; scoped: boolean; prefix: string; permissions: string[]; expiresAt: string | null };

const fullKey: KeyInfo = { id: "key_1", scoped: false, prefix: "", permissions: ["read", "write", "delete"], expiresAt: null };

const GB = 1024 ** 3;

const limitsBody = (owner: string | null, key: KeyInfo = fullKey) => ({
  account: "acct",
  key,
  plan: "free",
  tier: owner === null ? "unclaimed" : "claimed",
  ownerUsedBytes: owner === null ? null : 3 * GB,
  ownerLimitBytes: owner === null ? null : 10 * GB,
  usedBytes: 2048,
  files: 3,
  capBytes: 5 * GB,
  owner,
  expiresAt: owner === null ? "2026-11-02T00:00:00.000Z" : null,
  maxCapBytes: 10 * GB,
  maxFileBytes: 100 * 1024 ** 2,
  maxMultipartBytes: 1e12,
  partBytes: 1e7,
  maxBatchFiles: 1000,
  parallelUploads: 32,
});

const freshConfig = async () => runner(server, await mkdtemp(join(tmpdir(), "agentfs-config-")));

test("stdout that is not a terminal gets JSON by itself, and a failure ends with one error line", async () => {
  script.set("HEAD /v1/files/auto.txt", () => new Response(null, { headers: HEAD }));
  const piped = await agentfs.piped("stat", "auto.txt");
  expect(JSON.parse(piped.stdout).path).toBe("auto.txt");
  const text = await agentfs.piped("stat", "auto.txt", "--no-json");
  expect(text.stdout).toContain("path      auto.txt\n");

  const error = { code: "file_exists", message: "a file is at that path", retryAfter: null, requestId: "req_9" };
  script.set("POST /v1/files/undelete", () => Response.json({ error }, { status: 409 }));
  const failed = await agentfs.piped("undelete", "docs/a.txt");
  expect(failed.stdout).toBe(
    '{"event":"error","code":"file_exists","message":"a file is at that path","status":409,"requestId":"req_9"}\n',
  );
  expect(failed.code).toBe(1);

  const usage = await agentfs.piped("kv", "bogus", "key");
  expect(JSON.parse(usage.stdout)).toEqual({
    event: "error",
    code: "usage",
    message: "use: agentfs kv get|set|rm|ls",
    status: null,
    requestId: null,
  });
  expect(usage.code).toBe(2);
});

test("deleting and overwriting commands refuse without a terminal unless --yes is given", async () => {
  script.set("HEAD /v1/files/a.txt", () => new Response(null, { headers: HEAD }));
  script.set("HEAD /v1/files/b.txt", () => new Response(null, { headers: HEAD }));
  const refused = [
    await agentfs("rm", "-r", "old"),
    await agentfs("mv", "a.txt", "b.txt"),
    await agentfs("restore", "before"),
    await agentfs("kv", "rm", "lock"),
  ];
  for (const result of refused) {
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("there is no terminal to ask. Add --yes to go ahead.");
  }
  expect(seen.filter(({ method }) => method === "DELETE" || method === "POST").map(({ path }) => path)).not.toContain("/v1/files/move");
  expect(seen.some(({ method, path }) => method === "DELETE" && path === "/v1/kv/lock")).toBe(false);
});

test("status shows the key, account, owner and usage, and --check only sets the exit code", async () => {
  script.set("GET /v1/limits", () => Response.json(limitsBody(null)));
  const run = await freshConfig();
  const none = await run("status");
  expect(none.stdout).toBe("key       none; any command signs up, or run agentfs login --key-stdin\n");
  expect((await run("status", "--check")).code).toBe(1);
  expect(seen.map(({ path }) => path)).toEqual([]);

  await run.stdin("afs_AcctAcctAcctAcctAcctAcctAcctAcct\n", "login", "--key-stdin");
  const result = await run("status");
  expect(result.stdout).toContain("account   acct (full key)\n");
  expect(result.stdout).toContain("owner     nobody yet; run agentfs claim to keep these files\n");
  expect(result.stdout).toContain("used      2 KB of 5 GB (3 files)\n");
  const check = await run("status", "--check");
  expect(check.stdout).toBe("");
  expect(check.code).toBe(0);

  const scoped = { id: "key_2", scoped: true, prefix: "reports/", permissions: ["read", "write"], expiresAt: "2026-11-03T00:00:00.000Z" };
  script.set("GET /v1/limits", () => Response.json(limitsBody(null, scoped)));
  const limited = await run("status");
  expect(limited.stdout).toContain("account   acct (scoped key: reports/, read,write)\n");
  expect(limited.stdout).toContain("key ends  2026-11-03T00:00:00.000Z\n");
  expect(seen.some(({ path }) => path === "/v1/keys")).toBe(false);
});

test("login saves a key read from stdin after one validating call, and logout deletes it", async () => {
  script.set("GET /v1/limits", () => Response.json(limitsBody("hussein")));
  const dir = await mkdtemp(join(tmpdir(), "agentfs-config-"));
  const run = runner(server, dir);
  const refused = await run("login");
  expect(refused.code).toBe(2);

  const result = await run.stdin("afs_AcctAcctAcctAcctAcctAcctAcctAcct\n", "login", "--key-stdin");
  expect(result.stdout).toBe(`logged in as acct; the key is in ${join(dir, "agentfs", "key")}\n`);
  expect(seen.filter(({ path }) => path === "/v1/limits").map(({ headers }) => headers.get("authorization"))).toEqual(["Bearer afs_AcctAcctAcctAcctAcctAcctAcctAcct"]);
  expect(await readFile(join(dir, "agentfs", "key"), "utf8")).toBe("afs_AcctAcctAcctAcctAcctAcctAcctAcct");

  expect((await run("logout")).stdout).toBe("logged out\n");
  expect((await run("status", "--check")).code).toBe(1);
});

test("key list shows the keys made for the account and key revoke stops one", async () => {
  script.set("GET /v1/keys", () =>
    Response.json({
      keys: [
        { id: "key_1", prefix: "reports/", permissions: ["read", "write"], expiresAt: null, createdAt: "2026-10-29T00:00:00.000Z", last4: "abcd", revoked: false },
      ],
    }),
  );
  script.set("DELETE /v1/keys/key_1", () => new Response(null, { status: 204 }));
  const listed = await agentfs("key", "list");
  expect(listed.stdout).toBe("key_1\treports/\tread,write\tnever\t2026-10-29T00:00:00.000Z\t...abcd\tactive\n");
  const revoked = await agentfs("key", "revoke", "key_1");
  expect(revoked.stdout).toBe("key_1\n");
  expect(lastRequest()?.method).toBe("DELETE");
});

test("run ends with a summary line, and a command that outlives --timeout exits 124", async () => {
  const result = await agentfs("run", "--timeout", "1s", "--json", "--", "sleep", "30");
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  expect(result.code).toBe(124);
  expect(summary).toMatchObject({ event: "summary", exitCode: 124, pulled: 0, pushed: 0, bytes: 0 });
  expect(summary.seconds).toBeGreaterThanOrEqual(1);
});

test("restore last and diff last mean the newest snapshot", async () => {
  const entry = (name: string, createdAt: string) => ({ name, prefix: "", files: 1, bytes: 1, createdAt });
  script.set("GET /v1/snapshots", () =>
    Response.json({ snapshots: [entry("old", "2026-10-28T00:00:00.000Z"), entry("new", "2026-10-29T00:00:00.000Z")] }),
  );
  script.set("GET /v1/diff", () => Response.json({ from: "new", to: null, added: [], changed: [], removed: [] }));
  await agentfs("diff", "last");
  expect(lastRequest()?.query.get("from")).toBe("new");
  script.set("POST /v1/snapshots/new/restore", () => Response.json({ name: "new", to: "", restored: 1, deleted: 0 }));
  const restored = await agentfs("restore", "last", "--yes");
  expect(restored.stdout).toBe("new: 1 files restored, 0 deleted in everything\n");
});

test("--api-url picks the server over AGENTFS_URL", async () => {
  script.set("HEAD /v1/files/elsewhere.txt", () => new Response(null, { headers: HEAD }));
  const wrong = runner({ url: new URL("http://127.0.0.1:1") }, config);
  const result = await wrong("--api-url", server.url.href, "stat", "elsewhere.txt", "--json");
  expect(JSON.parse(result.stdout).path).toBe("elsewhere.txt");
});

test("in a terminal the confirmation asks first, and only y goes ahead", async () => {
  script.set("DELETE /v1/files", () => Response.json({ prefix: "old/", deleted: 2 }));
  const ask = async (answer: string) => {
    let out = "";
    let answered = false;
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts"), "rm", "-r", "old"], {
      env: { ...process.env, AGENTFS_URL: server.url.href, AGENTFS_KEY: "afs_TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT" },
      terminal: {
        cols: 100,
        rows: 10,
        data: (terminal, data) => {
          out += new TextDecoder().decode(data);
          if (out.includes("[y/N]") && !answered) {
            answered = true;
            terminal.write(answer);
          }
        },
      },
    });
    return { code: await child.exited, out };
  };
  seen.length = 0;
  const declined = await ask("n\n");
  expect(declined.out).toContain("this deletes everything under old/. Continue? [y/N]");
  expect(declined.code).toBe(1);
  expect(seen.filter(({ method }) => method === "DELETE")).toEqual([]);

  const accepted = await ask("y\n");
  expect(accepted.code).toBe(0);
  expect(accepted.out).toContain("2 files deleted from old/");
  expect(seen.filter(({ method }) => method === "DELETE").length).toBe(1);
});

test("rm, key rotate, feedback, claim and the other text-only commands print one JSON object in JSON mode", async () => {
  script.set("HEAD /v1/files/a.txt", () => new Response(null, { headers: HEAD }));
  script.set("DELETE /v1/files/a.txt", () => new Response(null, { status: 204 }));
  expect((await agentfs.piped("rm", "a.txt")).stdout).toBe('{"path":"a.txt","deleted":true}\n');

  script.set("POST /v1/feedback", () => Response.json({}));
  expect((await agentfs.piped("feedback", "slow", "uploads")).stdout).toBe('{"sent":true}\n');

  const link = { url: "https://agentfs.test/claim/abc", expiresAt: "2026-11-02T00:00:00.000Z" };
  script.set("POST /v1/claim", () => Response.json(link));
  expect(JSON.parse((await agentfs.piped("claim")).stdout)).toMatchObject(link);

  script.set("DELETE /v1/kv/lock", () => new Response(null, { status: 204 }));
  expect((await agentfs.piped("kv", "rm", "lock", "--if-version", "3")).stdout).toBe('{"key":"lock","deleted":true}\n');
  script.set("DELETE /v1/snapshots/before", () => new Response(null, { status: 204 }));
  expect((await agentfs.piped("snapshot", "rm", "before")).stdout).toBe('{"name":"before","deleted":true}\n');
  script.set("DELETE /v1/keys/key_1", () => new Response(null, { status: 204 }));
  expect((await agentfs.piped("key", "revoke", "key_1")).stdout).toBe('{"id":"key_1","revoked":true}\n');

  script.set("GET /v1/limits", () => Response.json(limitsBody("hussein")));
  script.set("POST /v1/keys/rotate", () => Response.json({ key: "afs_NewNewNewNewNewNewNewNewNewNewNe" }));
  const dir = await mkdtemp(join(tmpdir(), "agentfs-config-"));
  const run = runner(server, dir);
  await run.stdin("afs_AcctAcctAcctAcctAcctAcctAcctAcct\n", "login", "--key-stdin");
  const rotated = await run.piped("key", "rotate");
  expect(rotated.stdout).toBe(`{"rotated":true,"saved":true,"file":"${join(dir, "agentfs", "key")}"}\n`);
  expect(await readFile(join(dir, "agentfs", "key"), "utf8")).toBe("afs_NewNewNewNewNewNewNewNewNewNewNe");
});

test("limits and status show the plan, and free_storage_full prints the server's message", async () => {
  const run = await freshConfig();
  await run.stdin("afs_AcctAcctAcctAcctAcctAcctAcctAcct\n", "login", "--key-stdin");
  script.set("GET /v1/limits", () => Response.json(limitsBody("Hussein")));
  const shown = (await run("limits")).stdout;
  expect(shown).toContain("plan free: 3 GB of 10 GB used across your accounts\n");
  expect(shown).toContain("max file  100 MB on the free plan\n");
  const status = (await run("status")).stdout;
  expect(status).toContain("plan free: 3 GB of 10 GB used across your accounts\n");
  expect(status).toContain("owner     Hussein\n");

  const pro = { ...limitsBody("Hussein", { ...fullKey, id: null }), plan: "pro", capBytes: null, maxCapBytes: null, ownerLimitBytes: null };
  script.set("GET /v1/limits", () => Response.json(pro));
  const unlimited = (await run("limits")).stdout;
  expect(unlimited).toContain("plan pro: 3 GB used across your accounts\n");
  expect(unlimited).toContain("max cap   no limit on the pro plan\n");
  expect(JSON.parse((await run("status", "--json")).stdout).keyId).toBeNull();

  script.set("GET /v1/limits", () => Response.json({ ...limitsBody(null), maxCapBytes: GB }));
  expect((await run("limits")).stdout).toContain(
    "tier unclaimed: 1 GB max, deleted 24 hours after the first upload. Run agentfs claim to keep it.\n",
  );

  const error = { code: "free_storage_full", message: "your 10 GB of free storage is full", retryAfter: null };
  script.set("POST /v1/files/undelete", () => Response.json({ error }, { status: 413 }));
  const full = await run("undelete", "a.txt");
  expect(full.stderr).toBe("error: free_storage_full: your 10 GB of free storage is full\n");
  expect(full.code).toBe(1);
});

const withEnv = (env: Record<string, string>, cwd: string, ...args: string[]) => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts"), "--no-json", ...args], {
    cwd,
    env: { ...process.env, AGENTFS_URL: "", AGENTFS_KEY: "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(
    ([stdout, stderr, code]) => ({ stdout, stderr, code }),
  );
};

test("status with only a 0.0.2 login says to make a key, not that a command signs up", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentfs-legacy-"));
  await mkdir(join(home, "agentfs"));
  await writeFile(join(home, "agentfs", "credentials.json"), "{}");
  const result = await withEnv({ XDG_CONFIG_HOME: home, AGENTFS_URL: server.url.href }, home, "status", "--no-json");
  expect(result.stdout).toContain("found a 0.0.2 login");
  expect(result.stdout).toContain("agentfs login --key-stdin");
  expect(result.stdout).not.toContain("any command signs up");
});

test("a 0.0.2 login with no key stops instead of signing up a new account", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentfs-legacy-"));
  await mkdir(join(home, "agentfs"));
  await writeFile(join(home, "agentfs", "credentials.json"), '{"apiKey":"afs_OldOldOldOldOldOldOldOldOldOldOl"}');
  const result = await withEnv({ XDG_CONFIG_HOME: home, AGENTFS_URL: server.url.href }, home, "kv", "get", "a");
  expect(result.code).toBe(2);
  expect(result.stderr).toBe(
    `error: found a 0.0.2 login in ${join(home, "agentfs", "credentials.json")}, which this version does not read, and no key. Signing up now would start a new empty account. Get a key for that account from the API keys page of the dashboard on https://agentfs.cloud, then run: agentfs login --key-stdin\n`,
  );
  expect(seen.map(({ path }) => path)).toEqual([]);
});

test("AGENTFS_API_URL, the 0.0.2 name, works when AGENTFS_URL is not set", async () => {
  script.set("GET /v1/limits", () => Response.json(limitsBody(null)));
  const home = await mkdtemp(join(tmpdir(), "agentfs-alias-"));
  const result = await withEnv(
    { XDG_CONFIG_HOME: home, AGENTFS_API_URL: server.url.href, AGENTFS_KEY: "afs_AcctAcctAcctAcctAcctAcctAcctAcct" },
    home,
    "limits",
  );
  expect(result.code).toBe(0);
  expect(seen.map(({ path }) => path)).toEqual(["/v1/limits"]);
});

test("an empty XDG_CONFIG_HOME saves the key under the home folder, not the current folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentfs-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentfs-cwd-"));
  const result = await withEnv({ XDG_CONFIG_HOME: "", HOME: home, AGENTFS_URL: server.url.href }, cwd, "kv", "get", "a");
  expect(result.stderr).toContain(`Signed up. Your key is in ${join(home, ".config", "agentfs", "key")}\n`);
  expect(await readFile(join(home, ".config", "agentfs", "key"), "utf8")).toBe("afs_TestTestTestTestTestTestTestTest");
  expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd }))).toEqual([]);
});

test("the key goes only over HTTPS, or HTTP to localhost and 127.x", async () => {
  script.set("GET /v1/limits", () => Response.json(limitsBody(null)));
  const home = await mkdtemp(join(tmpdir(), "agentfs-https-"));
  const run = (url: string) =>
    withEnv({ XDG_CONFIG_HOME: home, AGENTFS_URL: url, AGENTFS_KEY: "afs_AcctAcctAcctAcctAcctAcctAcctAcct" }, home, "limits");
  for (const url of ["http://example.com", "http://localhost.evil.com", "http://127.evil.com"]) {
    const result = await run(url);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      `error: The API URL ${url} is not HTTPS. AgentFS only sends your key over HTTPS, or HTTP to localhost.\n`,
    );
  }
  expect((await run(`http://127.0.0.1:${server.port}`)).code).toBe(0);
  expect((await run(`http://localhost:${server.port}`)).code).toBe(0);
});

test("the command names from 0.0.2 print one line naming the new command, and sign nobody up", async () => {
  const lines = {
    upload: "agentfs upload is now agentfs put. Run: agentfs put <file or folder>... [--to folder]",
    share: "agentfs share is now agentfs sign. Run: agentfs sign <path> [--ttl 5m]",
    init: "agentfs init is gone: any command signs you up. To use a key you have, run: agentfs login --key-stdin",
  };
  const run = await freshConfig();
  for (const [name, line] of Object.entries(lines)) {
    const result = await run(name, "report.html");
    expect(result.stderr).toBe(`error: ${line}\n`);
    expect(result.code).toBe(2);
  }
  expect(seen).toEqual([]);
});

test("rm of a file that is not there fails with not_found, whether the server says 204 or 404", async () => {
  script.set("HEAD /v1/files/old.txt", () => new Response(null, { status: 404 }));
  script.set("DELETE /v1/files/old.txt", () => new Response(null, { status: 204 }));
  const old = await agentfs("rm", "old.txt");
  expect(old.stderr).toBe("error: not_found: no file at old.txt\n");
  expect(old.stdout).toBe("");
  expect(old.code).toBe(1);
  expect(seen.some(({ method }) => method === "DELETE")).toBe(false);

  script.set("HEAD /v1/files/new.txt", () => new Response(null, { headers: HEAD }));
  const error = { code: "not_found", message: "Nothing is here.", retryAfter: null };
  script.set("DELETE /v1/files/new.txt", () => Response.json({ error }, { status: 404 }));
  script.set("HEAD /v1/files/here.txt", () => new Response(null, { headers: HEAD }));
  script.set("DELETE /v1/files/here.txt", () => new Response(null, { status: 204 }));
  const mixed = await agentfs("rm", "new.txt", "here.txt");
  expect(mixed.stderr).toBe("error: not_found: no file at new.txt\n");
  expect(mixed.stdout).toBe("here.txt\n");
  expect(mixed.code).toBe(1);
});

test("rm works for a key that can delete but not read", async () => {
  script.set("HEAD /v1/files/runs/a.txt", () => new Response(null, { status: 403 }));
  script.set("DELETE /v1/files/runs/a.txt", () => new Response(null, { status: 204 }));
  const result = await agentfs("rm", "runs/a.txt");
  expect(result.stdout).toBe("runs/a.txt\n");
  expect(result.code).toBe(0);
  script.delete("HEAD /v1/files/runs/a.txt");
});

test("ls --search sends q, and lists only matching paths even when the server ignores q", async () => {
  script.set("GET /v1/files", () =>
    Response.json({
      files: [file("runs/1/Report.html", null), file("runs/1/data.csv", null), file("runs/2/weekly-report.md", null)],
      folders: [],
      cursor: null,
    }),
  );
  const result = await agentfs("ls", "runs", "--search", "report");
  expect(result.stdout).toBe(
    "runs/1/Report.html\t2 KB\t-\t-\thttps://files.test/runs/1/Report.html\nruns/2/weekly-report.md\t2 KB\t-\t-\thttps://files.test/runs/2/weekly-report.md\n",
  );
  expect(lastRequest()?.query.get("q")).toBe("report");
  expect(lastRequest()?.query.get("prefix")).toBe("runs/");
  expect(lastRequest()?.query.has("delimiter")).toBe(false);
});

test("mcp prints the full key and says so, or makes a key for one folder and says which", async () => {
  script.set("GET /v1/limits", () => Response.json(limitsBody("hussein")));
  const run = await freshConfig();
  await run.stdin("afs_FullFullFullFullFullFullFullFull\n", "login", "--key-stdin");
  const full = await run("mcp");
  expect(JSON.parse(full.stdout).mcpServers.agentfs.headers.Authorization).toBe("Bearer afs_FullFullFullFullFullFullFullFull");
  expect(full.stderr).toStartWith("key: your full key, which opens every folder and can do everything.");

  const made = { id: "key_7", key: "afs_ScopeScopeScopeScopeScopeScopeSc", prefix: "runs/t1/", permissions: ["read", "write"], expiresAt: "2026-11-04T00:00:00.000Z" };
  script.set("POST /v1/keys", () => Response.json(made, { status: 201 }));
  const scoped = await run("mcp", "--prefix", "runs/t1", "--ttl", "1d");
  expect(JSON.parse(lastRequest()?.body ?? "")).toEqual({ prefix: "runs/t1/", permissions: ["read", "write"], ttlSeconds: 86400 });
  expect(JSON.parse(scoped.stdout).mcpServers.agentfs.headers.Authorization).toBe("Bearer afs_ScopeScopeScopeScopeScopeScopeSc");
  expect(scoped.stdout).not.toContain("afs_FullFullFullFullFullFullFullFull");
  expect(scoped.stderr).toBe("key: a new scoped key, key_7: runs/t1/, read,write, ends 2026-11-04T00:00:00.000Z. Stop it with agentfs key revoke key_7.\n");
});

test("claim gives the human the link and both deadlines, or the server's message when it sends one", async () => {
  script.set("GET /v1/limits", () => Response.json(limitsBody(null)));
  const link = { url: "https://agentfs.test/claim/abc", expiresAt: "2026-11-02T00:00:00.000Z" };
  script.set("POST /v1/claim", () => Response.json(link));
  const text = await agentfs("claim");
  expect(text.stdout).toBe("https://agentfs.test/claim/abc\n");
  expect(text.stderr).toBe(
    "Give your person this link:\nhttps://agentfs.test/claim/abc\nThey sign in with GitHub or Google to keep these files. The link works until 2026-11-02T00:00:00.000Z. Files nobody has claimed are deleted at 2026-11-02T00:00:00.000Z.\n",
  );
  expect(JSON.parse((await agentfs.piped("claim")).stdout)).toEqual({ ...link, message: text.stderr.trimEnd() });

  script.set("POST /v1/claim", () => Response.json({ ...link, message: "Open the link." }));
  expect(JSON.parse((await agentfs.piped("claim")).stdout)).toEqual({ ...link, message: "Open the link." });
});

const privateFile = (path: string) => ({ ...file(path, null), url: null, private: true });

test("put --private asks for a private file, and prints no link for it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentfs-private-"));
  await writeFile(join(dir, "page.html"), "<h1>secret</h1>");
  script.set("GET /v1/limits", () => Response.json(limitsBody(null)));
  script.set("POST /v1/files", () =>
    Response.json({ files: [{ path: "cache/page.html", status: "missing", current: null }] }),
  );
  script.set("PUT /v1/files/cache/page.html", () =>
    Response.json({ ...privateFile("cache/page.html"), status: "uploaded" }),
  );
  const result = await runner(server, config, dir)(
    "put", "page.html", "--to", "cache", "--private",
  );
  expect(result.stdout).toBe("cache/page.html (private, no public link)\n");
  const linkBody = seen.find(({ method, path }) => method === "POST" && path === "/v1/files")?.body ?? "";
  expect(JSON.parse(linkBody).files[0].private).toBe(true);
  const put = seen.find(({ method }) => method === "PUT");
  expect(put?.headers.get("x-agentfs-private")).toBe("true");

  const both = await runner(server, config, dir)("put", "page.html", "--private", "--public");
  expect(both.code).not.toBe(0);
  expect(both.stderr).toContain("use --private or --public, not both");
  await runner(server, config, dir)("put", "page.html", "--to", "cache", "--public", "--force");
  const second = seen.findLast(({ method }) => method === "PUT");
  expect(second?.headers.get("x-agentfs-private")).toBe("false");
});

test("put without a flag sends no private header, so a private file keeps its privacy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentfs-private-"));
  await writeFile(join(dir, "again.txt"), "again");
  script.set("PUT /v1/files/again.txt", () =>
    Response.json({ ...privateFile("again.txt"), status: "uploaded" }),
  );
  await runner(server, config, dir)("put", "again.txt");
  expect(seen.find(({ method }) => method === "PUT")?.headers.has("x-agentfs-private")).toBe(false);
});

test("sign prints the signed link and sends the lifetime in seconds", async () => {
  script.set("POST /v1/files/sign", () =>
    Response.json({ url: "https://files.test/acct/a.txt?token=1.abc", expiresAt: "2026-11-05T00:05:00.000Z" }),
  );
  const result = await agentfs("sign", "a.txt", "--ttl", "5m");
  expect(result.stdout).toBe("https://files.test/acct/a.txt?token=1.abc\n");
  expect(JSON.parse(lastRequest()?.body ?? "{}")).toEqual({ path: "a.txt", ttlSeconds: 300 });
});

test("ls and stat show a private file as private", async () => {
  script.set("GET /v1/files", () =>
    Response.json({ files: [privateFile("cache/a.txt")], folders: [], cursor: null }),
  );
  const listed = await agentfs("ls", "cache");
  expect(listed.stdout).toBe("cache/a.txt\t2 KB\t-\t-\tprivate\n");
  script.set("HEAD /v1/files/cache/b.txt", () => {
    const { "x-agentfs-url": _omitted, ...headers } = HEAD;
    return new Response(null, { headers: { ...headers, "x-agentfs-private": "true" } });
  });
  const stat = await agentfs("stat", "cache/b.txt");
  expect(stat.stdout).toContain("private   true\nlink      none, the file is private\n");
});

test("pull reads a private file with the key, because it has no link", async () => {
  const into = await mkdtemp(join(tmpdir(), "agentfs-pull-"));
  const sha256 = new Bun.CryptoHasher("sha256").update("secret").digest("hex");
  script.set("GET /v1/files", () =>
    Response.json({ files: [{ ...privateFile("cache/s.txt"), sha256 }], folders: [], cursor: null }),
  );
  script.set("GET /v1/content/cache/s.txt", () => new Response("secret"));
  await runner(server, config, into)("pull", "cache");
  expect(await readFile(join(into, "cache", "s.txt"), "utf8")).toBe("secret");
  const read = seen.find(({ path }) => path === "/v1/content/cache/s.txt");
  expect(read?.headers.get("authorization")).toStartWith("Bearer afs_");
});
