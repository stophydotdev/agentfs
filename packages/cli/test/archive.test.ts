import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runner } from "./cli";

const SPEC = [
  `CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parameters TEXT,
  result TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
)`,
  `CREATE TABLE fs_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE fs_inode (
  ino INTEGER PRIMARY KEY AUTOINCREMENT,
  mode INTEGER NOT NULL,
  nlink INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  gid INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  atime INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  ctime INTEGER NOT NULL,
  rdev INTEGER NOT NULL DEFAULT 0,
  atime_nsec INTEGER NOT NULL DEFAULT 0,
  mtime_nsec INTEGER NOT NULL DEFAULT 0,
  ctime_nsec INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE fs_dentry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_ino INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  UNIQUE(parent_ino, name)
)`,
  `CREATE TABLE fs_data (
  ino INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (ino, chunk_index)
)`,
  `CREATE TABLE fs_symlink (
  ino INTEGER PRIMARY KEY,
  target TEXT NOT NULL
)`,
  `CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
)`,
];

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);

const fakeServer = (seed: { files: Record<string, Uint8Array>; kv: Record<string, unknown> }) => {
  const files = new Map(Object.entries(seed.files));
  const kv = new Map(Object.entries(seed.kv));
  const events: unknown[] = [];
  const pathOf = (request: Request, prefix: string) =>
    decodeURIComponent(new URL(request.url).pathname.slice(prefix.length));
  const entry = (path: string, bytes: Uint8Array, request: Request) => ({
    path,
    size: bytes.length,
    sha256: sha256(bytes),
    contentType: "application/octet-stream",
    agent: null,
    session: null,
    commit: null,
    updatedAt: "2026-10-29T00:00:00.000Z",
    expiresAt: null,
    verified: true,
    url: new URL(`/blob/${path}`, request.url).href,
  });
  const item = (key: string, value: unknown) => ({
    key,
    value,
    version: 1,
    updatedAt: "2026-10-29T00:00:00.000Z",
    expiresAt: null,
  });
  const server = Bun.serve({
    port: 0,
    routes: {
      "/v1/signup": { POST: () => Response.json({ key: "afs_test" }, { status: 201 }) },
      "/v1/limits": () =>
        Response.json({
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
      "/v1/files": {
        GET: (request) => {
          const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
          const listed = Array.from(files)
            .filter(([path]) => path.startsWith(prefix))
            .map(([path, bytes]) => entry(path, bytes, request));
          return Response.json({ files: listed, folders: [], cursor: null });
        },
        POST: async (request) => {
          const wanted: { files: { path: string }[] } = await request.json();
          const answers = wanted.files.map(({ path }) => ({ path, status: "missing", current: null }));
          return Response.json({ files: answers });
        },
      },
      "/v1/files/*": {
        PUT: async (request) => {
          const path = pathOf(request, "/v1/files/");
          const bytes = new Uint8Array(await request.arrayBuffer());
          files.set(path, bytes);
          return Response.json({ ...entry(path, bytes, request), status: "uploaded" });
        },
      },
      "/blob/*": (request) => {
        const bytes = files.get(pathOf(request, "/blob/"));
        return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice());
      },
      "/v1/kv": {
        GET: (request) => {
          const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
          const items = Array.from(kv)
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => item(key, value));
          return Response.json({ items, cursor: null });
        },
      },
      "/v1/kv/*": {
        PUT: async (request) => {
          const key = pathOf(request, "/v1/kv/");
          kv.set(key, await request.json());
          return Response.json(item(key, kv.get(key)));
        },
      },
      "/v1/events": {
        POST: async (request) => {
          const body: { name: string } = await request.json();
          events.push(body);
          const stored = {
            id: String(events.length),
            at: "2026-10-29T00:00:00.000Z",
            op: "tool",
            path: null,
            from: null,
            sha256: null,
            size: null,
            agent: null,
            session: null,
            commit: null,
            name: body.name,
            input: null,
            output: null,
            status: "ok",
            durationMs: 0,
          };
          return Response.json(stored, { status: 201 });
        },
      },
    },
  });
  return { server, files, kv, events };
};

const servers: { stop: () => unknown }[] = [];
const serve = (seed: Parameters<typeof fakeServer>[0]) => {
  const fake = fakeServer(seed);
  servers.push(fake.server);
  return fake;
};
afterAll(() => {
  for (const server of servers) server.stop();
});

const cli = async (fake: { server: { url: URL } }) =>
  runner(fake.server, await mkdtemp(join(tmpdir(), "agentfs-config-")));

const workDir = () => mkdtemp(join(tmpdir(), "agentfs-archive-"));

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

test("import brings in the files, kv entries and tool calls of a Turso AgentFS database", async () => {
  const file = join(await workDir(), "fixture.db");
  const db = new Database(file);
  for (const statement of SPEC) db.run(statement);
  db.run("INSERT INTO fs_config (key, value) VALUES ('chunk_size', '4096')");
  const inode = db.prepare("INSERT INTO fs_inode (ino, mode, nlink, size, atime, mtime, ctime) VALUES (?, ?, 1, ?, 0, 0, 0)");
  inode.run(1, 0o040755, 0);
  inode.run(2, 0o040755, 0);
  inode.run(3, 0o100644, 5000);
  inode.run(4, 0o100644, 5);
  inode.run(5, 0o120777, 9);
  const dentry = db.prepare("INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)");
  dentry.run("docs", 1, 2);
  dentry.run("a.txt", 2, 3);
  dentry.run("readme.md", 1, 4);
  dentry.run("link", 1, 5);
  const chunk = db.prepare("INSERT INTO fs_data (ino, chunk_index, data) VALUES (?, ?, ?)");
  chunk.run(3, 0, encode("a".repeat(4096)));
  chunk.run(3, 1, encode("b".repeat(904)));
  chunk.run(4, 0, encode("hello"));
  db.run("INSERT INTO fs_symlink (ino, target) VALUES (5, 'readme.md')");
  db.run(`INSERT INTO kv_store (key, value) VALUES ('prefs', '{"theme":"dark"}'), ('note', '"hi"')`);
  db.run(
    `INSERT INTO tool_calls (name, parameters, result, error, started_at, completed_at, duration_ms) VALUES
     ('search', '{"q":"cats"}', '{"hits":3}', NULL, 1761696000, 1761696001, 1000),
     ('fetch', NULL, NULL, 'timeout', 1761696005, 1761696006, 1000)`,
  );
  db.close();

  const fake = serve({ files: {}, kv: {} });
  const result = await (await cli(fake))("import", file);

  expect(result.stdout).toBe("files       2 (4.9 KB)\nkv entries  2\ntool calls  2\nskipped     1\n");
  expect(result.stderr).toContain("skipped: link (symlink)\n");
  expect(result.code).toBe(0);
  expect(text(fake.files.get("fixture/docs/a.txt"))).toBe("a".repeat(4096) + "b".repeat(904));
  expect(text(fake.files.get("fixture/readme.md"))).toBe("hello");
  expect(Object.fromEntries(fake.kv)).toEqual({ prefs: { theme: "dark" }, note: "hi" });
  expect(fake.events).toEqual([
    {
      op: "tool",
      name: "search",
      input: { q: "cats" },
      output: { hits: 3 },
      status: "ok",
      durationMs: 1000,
      startedAt: "2025-10-29T00:00:00.000Z",
    },
    {
      op: "tool",
      name: "fetch",
      output: "timeout",
      status: "error",
      durationMs: 1000,
      startedAt: "2025-10-29T00:00:05.000Z",
    },
  ]);
});

const reports = {
  files: {
    "reports/a.txt": encode("a".repeat(5000)),
    "reports/sub/b.txt": encode("bee"),
    "other/c.txt": encode("see"),
  },
  kv: { "reports/state": { n: 1 }, "other/x": 2 },
};

test("export writes a database in Turso's schema from a folder and the kv entries under it", async () => {
  const file = join(await workDir(), "reports.db");
  const run = await cli(serve(reports));
  const result = await run("export", "reports", file);
  expect(result.stdout).toBe(`2 files (4.9 KB) and 1 kv entries written to ${file}\n`);

  const db = new Database(file, { readonly: true });
  expect(db.query("SELECT value FROM fs_config WHERE key = 'chunk_size'").all()).toEqual([{ value: "4096" }]);
  expect(db.query("SELECT mode FROM fs_inode WHERE ino = 1").all()).toEqual([{ mode: 0o040755 }]);
  const names = db.query("SELECT name, parent_ino FROM fs_dentry ORDER BY name").all();
  expect(names).toEqual([
    { name: "a.txt", parent_ino: 1 },
    { name: "b.txt", parent_ino: 3 },
    { name: "sub", parent_ino: 1 },
  ]);
  const chunks = db
    .query("SELECT length(data) AS length FROM fs_data WHERE ino = (SELECT ino FROM fs_dentry WHERE name = 'a.txt') ORDER BY chunk_index")
    .all();
  expect(chunks).toEqual([{ length: 4096 }, { length: 904 }]);
  expect(db.query("SELECT key, value FROM kv_store").all()).toEqual([{ key: "reports/state", value: '{"n":1}' }]);
  db.close();

  const again = await run("export", "reports", file);
  expect(again.stderr).toBe(`error: ${file} already exists\n`);
  expect(again.code).toBe(1);
});

test("a folder exported and imported into a fresh server comes back the same", async () => {
  const file = join(await workDir(), "reports.db");
  await (await cli(serve(reports)))("export", "reports", file);

  const fresh = serve({ files: {}, kv: {} });
  const result = await (await cli(fresh))("import", file, "--to", "reports");
  expect(result.code).toBe(0);
  expect(Object.fromEntries(Array.from(fresh.files, ([path, bytes]) => [path, text(bytes)]))).toEqual({
    "reports/a.txt": "a".repeat(5000),
    "reports/sub/b.txt": "bee",
  });
  expect(Object.fromEntries(fresh.kv)).toEqual({ "reports/state": { n: 1 } });
});

test("import refuses a file that is not an AgentFS database", async () => {
  const file = join(await workDir(), "other.db");
  const db = new Database(file);
  db.run("CREATE TABLE notes (id INTEGER)");
  db.close();
  const result = await (await cli(serve({ files: {}, kv: {} })))("import", file);
  expect(result.stderr).toContain(`error: ${file} is not an AgentFS database: no fs_inode table\n`);
  expect(result.code).toBe(1);
});
