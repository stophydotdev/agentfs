import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { AgentFS, AgentFSError } from "../src/index";
import { startStub } from "./stub";

const MB = 1024 * 1024;
// A Pro plan: its file cap is 5 TB, which must not decide when a write goes up in parts.
const stub = startStub({ maxFileBytes: 5 * 1024 * 1024 * MB, partBytes: 32 * MB, urlsPerBatch: 2, pageSize: 2 });
afterAll(() => stub.stop());

const KEY = `afs_${"b".repeat(32)}`;
const open = (prefix?: string) => AgentFS.open({ key: KEY, url: stub.url, prefix });

beforeEach(() => {
  stub.files.clear();
  stub.kv.clear();
  stub.events.length = 0;
});

const caught = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (failure: unknown) => failure,
  );
  if (!(error instanceof AgentFSError)) throw new Error("expected an AgentFSError");
  return error;
};

describe("fs", () => {
  test("a file written with a leading slash reads back as a Buffer or a string", async () => {
    const agent = await open();
    await agent.fs.writeFile("/notes/a.txt", "hello");
    expect(stub.files.has("notes/a.txt")).toBe(true);
    expect((await agent.fs.readFile("/notes/a.txt")).toString()).toBe("hello");
    expect(await agent.fs.readFile("notes/a.txt", "utf8")).toBe("hello");
    expect(await agent.fs.readFile("notes/a.txt", { encoding: "base64" })).toBe("aGVsbG8=");
  });

  test("prefix roots every path in a folder", async () => {
    const agent = await open("runs/42/");
    await agent.fs.writeFile("/a.txt", "x");
    expect([...stub.files.keys()]).toEqual(["runs/42/a.txt"]);
    expect(await agent.fs.readdir("/")).toEqual(["a.txt"]);
  });

  test("readdir lists names one level deep, across pages, folders included", async () => {
    const agent = await open();
    for (const path of ["d/a", "d/b", "d/c", "d/sub/x", "d/sub/y", "other"]) {
      await agent.fs.writeFile(path, path);
    }
    expect(await agent.fs.readdir("/d")).toEqual(["a", "b", "c", "sub"]);
    expect(await agent.fs.readdir("/")).toEqual(["d", "other"]);
  });

  test("stat tells files from folders and a missing path is ENOENT with our code and request id", async () => {
    const agent = await open();
    await agent.fs.writeFile("/d/a.txt", "12345");
    const file = await agent.fs.stat("/d/a.txt");
    expect([file.isFile(), file.size]).toEqual([true, 5]);
    expect((await agent.fs.stat("/d")).isDirectory()).toBe(true);
    const missing = await caught(agent.fs.stat("/nope"));
    expect([missing.code, missing.agentfsCode, missing.syscall, missing.path]).toEqual([
      "ENOENT",
      "not_found",
      "stat",
      "/nope",
    ]);
    expect(missing.requestId).toMatch(/^req-\d+$/u);
    expect((await caught(agent.fs.readFile("/d"))).code).toBe("EISDIR");
    expect((await caught(agent.fs.readdir("/d/a.txt"))).code).toBe("ENOTDIR");
  });

  test("mkdir succeeds without a request and the folder lists as empty", async () => {
    const agent = await open();
    stub.seen.requests.length = 0;
    await agent.fs.mkdir("/empty");
    expect(stub.seen.requests).toEqual([]);
    expect(await agent.fs.readdir("/empty")).toEqual([]);
    expect(await agent.fs.exists("/empty")).toBe(true);
    await agent.fs.rmdir("/empty");
    expect(await agent.fs.exists("/empty")).toBe(false);
  });

  test("unlink, rm and rmdir report what Node reports", async () => {
    const agent = await open();
    await agent.fs.writeFile("/d/a", "1");
    expect((await caught(agent.fs.unlink("/missing"))).code).toBe("ENOENT");
    expect((await caught(agent.fs.unlink("/d"))).code).toBe("EISDIR");
    expect((await caught(agent.fs.rmdir("/d"))).code).toBe("ENOTEMPTY");
    expect((await caught(agent.fs.rm("/d"))).code).toBe("EISDIR");
    await agent.fs.rm("/missing", { force: true });
    await agent.fs.rm("/d", { recursive: true });
    expect(stub.files.size).toBe(0);
    await agent.fs.writeFile("/f", "1");
    await agent.fs.unlink("/f");
    expect(stub.files.size).toBe(0);
  });

  test("rename moves a file and a whole folder", async () => {
    const agent = await open();
    await agent.fs.writeFile("/a.txt", "1");
    await agent.fs.writeFile("/dir/x", "2");
    await agent.fs.rename("/a.txt", "/b.txt");
    await agent.fs.rename("/dir", "/moved");
    expect([...stub.files.keys()].sort()).toEqual(["b.txt", "moved/x"]);
    expect((await caught(agent.fs.rename("/nope", "/x"))).code).toBe("ENOENT");
  });

  test("copyFile links the same bytes without uploading them again", async () => {
    const agent = await open();
    await agent.fs.writeFile("/a.txt", "same bytes");
    stub.seen.requests.length = 0;
    await agent.fs.copyFile("/a.txt", "/b.txt");
    expect(stub.seen.requests.some((request) => request.startsWith("PUT /v1/files"))).toBe(false);
    expect(await agent.fs.readFile("/b.txt", "utf8")).toBe("same bytes");
  });

  test("a write above 90 MB goes straight to storage in parts, whatever the plan's file cap", async () => {
    const agent = await open();
    const big = new Uint8Array(90 * MB + 17).fill(7);
    for (let at = 0; at < big.length; at += 1_000_003) big[at] = at % 251;
    stub.seen.partFetches = 0;
    await agent.fs.writeFile("/big.bin", big);
    expect(stub.seen.partFetches).toBe(1);
    const back = await agent.fs.readFile("/big.bin");
    expect(back.equals(big)).toBe(true);
    expect((await agent.fs.stat("/big.bin")).size).toBe(big.byteLength);
  });

  test("a failed direct upload is aborted", async () => {
    const agent = await open();
    const big = new Uint8Array(90 * MB + 1).fill(7);
    const hashing = crypto.subtle.digest;
    crypto.subtle.digest = async () => new Uint8Array(32).buffer;
    stub.seen.aborted = 0;
    const failure = await caught(agent.fs.writeFile("/bad.bin", big)).finally(() => {
      crypto.subtle.digest = hashing;
    });
    expect(failure.agentfsCode).toBe("upload_incomplete");
    expect(stub.seen.aborted).toBe(1);
  });

  test("open reads a byte range and fstat sees the size", async () => {
    const agent = await open();
    await agent.fs.writeFile("/r.txt", "0123456789");
    const handle = await agent.fs.open("/r.txt");
    expect((await handle.pread(2, 4)).toString()).toBe("2345");
    expect((await handle.fstat()).size).toBe(10);
    await handle.truncate(3);
    expect(await agent.fs.readFile("/r.txt", "utf8")).toBe("012");
  });

  test("server errors keep our code and request id, and take a Node code where there is one", async () => {
    const agent = await open();
    const scoped = await caught(agent.fs.writeFile("/locked/a", "x"));
    expect([scoped.code, scoped.agentfsCode, scoped.status, scoped.syscall]).toEqual(["EPERM", "key_scope", 403, "open"]);
    expect(scoped.requestId).toMatch(/^req-\d+$/u);
    const full = await caught(agent.fs.writeFile("/full/a", "x"));
    expect([full.code, full.agentfsCode]).toEqual(["storage_cap_reached", "storage_cap_reached"]);
  });

  test("symlink is ENOSYS", async () => {
    const agent = await open();
    expect((await caught(agent.fs.symlink("/a", "/b"))).code).toBe("ENOSYS");
  });

  test("link returns the public url, and statfs the account totals", async () => {
    const agent = await open();
    await agent.fs.writeFile("/pub/a.txt", "abc");
    expect(await agent.fs.link("/pub/a.txt")).toBe(`${stub.url}/${stub.account}/pub/a.txt`);
    expect(await agent.fs.statfs()).toEqual({ inodes: 1, bytesUsed: 3 });
  });
});

describe("private files", () => {
  test("a private write has no public link, and readFile, copyFile and pread use the key", async () => {
    const agent = await open();
    stub.seen.requests.length = 0;
    await agent.fs.writeFile("/cache/a.html", "<h1>secret</h1>", { private: true });
    expect(stub.files.get("cache/a.html")?.private).toBe(true);
    expect((await caught(agent.fs.link("/cache/a.html"))).code).toBe("EPERM");
    expect(await agent.fs.readFile("/cache/a.html", "utf8")).toBe("<h1>secret</h1>");
    expect(stub.seen.requests).toContain("GET /v1/content/cache/a.html");
    expect(stub.seen.requests.some((request) => request.startsWith(`GET /${stub.account}/`))).toBe(false);
    const handle = await agent.fs.open("/cache/a.html");
    expect((await handle.pread(4, 6)).toString()).toBe("secret");

    await agent.fs.copyFile("/cache/a.html", "/cache/b.html");
    expect(stub.files.get("cache/b.html")?.private).toBe(true);
  });

  test("a write without the option keeps a private file private, and private: false makes it public", async () => {
    const agent = await open();
    await agent.fs.writeFile("/n.txt", "one", { private: true });
    await agent.fs.writeFile("/n.txt", "two");
    expect(stub.files.get("n.txt")?.private).toBe(true);
    await agent.fs.writeFile("/n.txt", "three", { encoding: "utf8", private: false });
    expect(stub.files.get("n.txt")?.private).toBe(false);
    expect(await agent.fs.link("/n.txt")).toStartWith(`${stub.url}/${stub.account}/n.txt`);
  });

  test("signedUrl asks for a link that opens the file without a key", async () => {
    const agent = await open();
    await agent.fs.writeFile("/s.txt", "signed", { private: true });
    const link = await agent.fs.signedUrl("/s.txt", { ttlSeconds: 60 });
    expect(stub.seen.signs).toEqual([{ path: "s.txt", ttlSeconds: 60 }]);
    expect(await (await fetch(link.url)).text()).toBe("signed");
    expect((await fetch(link.url.replace("?token=signed", ""))).status).toBe(404);
    expect((await caught(agent.fs.signedUrl("/missing.txt"))).code).toBe("ENOENT");
  });

  test("a private file above the part size goes up in parts and stays private", async () => {
    const agent = await open();
    await agent.fs.writeFile("/big.bin", new Uint8Array(91 * MB), { private: true });
    expect(stub.files.get("big.bin")?.private).toBe(true);
  });
});

describe("kv", () => {
  test("set, get, list and delete round trip JSON under the prefix", async () => {
    const agent = await open("runs/42/");
    await agent.kv.set("user:prefs", { theme: "dark" });
    await agent.kv.set("user:other", [1, 2]);
    await agent.kv.set("zzz", "z");
    expect([...stub.kv.keys()].sort()).toEqual(["runs/42/user:other", "runs/42/user:prefs", "runs/42/zzz"]);
    expect(await agent.kv.get<{ theme: string }>("user:prefs")).toEqual({ theme: "dark" });
    expect(await agent.kv.list("user:")).toEqual([
      { key: "user:other", value: [1, 2] },
      { key: "user:prefs", value: { theme: "dark" } },
    ]);
    await agent.kv.delete("user:prefs");
    expect(await agent.kv.get("user:prefs")).toBeUndefined();
  });
});

describe("tools", () => {
  test("record stores a tool event and get, getByName and getRecent read it back", async () => {
    const agent = await open();
    const first = await agent.tools.record("search", 1000, 1001.5, { q: "a" }, { hits: 3 });
    const second = await agent.tools.record("fetch", 2000, 2001, undefined, undefined, "timeout");
    expect(second).toBeGreaterThan(first);
    expect(stub.events[0]).toMatchObject({ op: "tool", name: "search", status: "ok", durationMs: 1500, input: { q: "a" }, output: { hits: 3 } });
    expect(stub.events[1]).toMatchObject({ status: "error", output: { error: "timeout" } });
    expect(await agent.tools.get(first)).toEqual({
      id: first,
      name: "search",
      parameters: { q: "a" },
      result: { hits: 3 },
      status: "success",
      started_at: 1000,
      completed_at: 1001.5,
      duration_ms: 1500,
    });
    expect((await agent.tools.get(second))?.error).toBe("timeout");
    expect(await agent.tools.get(999)).toBeUndefined();
    expect((await agent.tools.getByName("search")).map((call) => call.id)).toEqual([first]);
    expect((await agent.tools.getRecent(1500)).map((call) => call.id)).toEqual([second]);
  });
});

describe("cloud extras", () => {
  test("snapshot, diff and restore work on a folder", async () => {
    const agent = await open("work/");
    await agent.fs.writeFile("/a.txt", "1");
    await agent.fs.writeFile("/b.txt", "2");
    expect(await agent.snapshot("before", "/")).toMatchObject({ name: "before", prefix: "work/", files: 2, bytes: 2 });
    await agent.fs.writeFile("/a.txt", "changed");
    await agent.fs.writeFile("/c.txt", "new");
    await agent.fs.unlink("/b.txt");
    const diff = await agent.diff("before");
    expect([diff.to, diff.added.map((file) => file.path), diff.changed.map((file) => file.path), diff.removed.map((file) => file.path)]).toEqual([
      null,
      ["work/c.txt"],
      ["work/a.txt"],
      ["work/b.txt"],
    ]);
    expect(await agent.restore("before")).toMatchObject({ restored: 2, deleted: 1 });
    expect(await agent.fs.readFile("/a.txt", "utf8")).toBe("1");
    expect(await agent.fs.exists("/c.txt")).toBe(false);
  });
});

describe("analytics headers", () => {
  test("every request says agentfs-sdk/<version>, and writes carry the agent name", async () => {
    const agent = await AgentFS.open({ key: KEY, url: stub.url, agent: "my-bot" });
    stub.seen.userAgents.clear();
    stub.seen.writeAgents.length = 0;
    stub.seen.readAgents.length = 0;
    await agent.fs.writeFile("/a.txt", "x");
    await agent.fs.readFile("/a.txt");
    await agent.kv.set("k", 1);
    expect([...stub.seen.userAgents]).toEqual([`agentfs-sdk/${version}`]);
    expect(new Set(stub.seen.writeAgents)).toEqual(new Set(["my-bot"]));
    expect(new Set(stub.seen.readAgents)).toEqual(new Set([null]));
    expect((await caught(AgentFS.open({ key: KEY, url: stub.url, agent: "bad name" }))).code).toBe("EINVAL");
  });
});

describe("opening", () => {
  const withEnv = async (values: Record<string, string | undefined>, work: () => Promise<void>) => {
    const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      await work();
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  test("the key comes from the option, then AGENTFS_KEY, then the key file, then a signup that is saved", async () => {
    const config = await mkdtemp(join(tmpdir(), "agentfs-sdk-"));
    await withEnv({ AGENTFS_KEY: undefined, AGENTFS_URL: stub.url, XDG_CONFIG_HOME: config }, async () => {
      stub.seen.signups = 0;
      const signed = await AgentFS.open();
      expect(stub.seen.signups).toBe(1);
      const file = join(config, "agentfs", "key");
      expect(await readFile(file, "utf8")).toBe(signed.key);
      expect((await AgentFS.open()).key).toBe(signed.key);
      expect(stub.seen.signups).toBe(1);
      process.env.AGENTFS_KEY = `afs_${"c".repeat(32)}`;
      expect((await AgentFS.open()).key).toBe(process.env.AGENTFS_KEY);
      expect((await AgentFS.open({ key: KEY })).key).toBe(KEY);
      expect((await AgentFS.open({ key: KEY })).url).toBe(stub.url);
    });
  });

  test("a 0.0.2 login and no key stops instead of signing up a new empty account", async () => {
    const config = await mkdtemp(join(tmpdir(), "agentfs-sdk-"));
    await mkdir(join(config, "agentfs"), { recursive: true });
    await writeFile(join(config, "agentfs", "credentials.json"), "{}");
    await withEnv({ AGENTFS_KEY: undefined, AGENTFS_URL: stub.url, XDG_CONFIG_HOME: config }, async () => {
      stub.seen.signups = 0;
      const error = await caught(AgentFS.open());
      expect(error.message).toContain(`found a 0.0.2 login in ${join(config, "agentfs", "credentials.json")}`);
      expect(stub.seen.signups).toBe(0);
    });
  });

  test("the key goes only over HTTPS, or HTTP to localhost and 127.x", async () => {
    for (const url of ["http://example.com", "http://localhost.evil.com", "http://127.evil.com"]) {
      const error = await caught(AgentFS.open({ key: KEY, url }));
      expect(error.message).toBe(
        `EINVAL: The API URL ${url} is not HTTPS. AgentFS only sends your key over HTTPS, or HTTP to localhost.`,
      );
    }
    expect((await AgentFS.open({ key: KEY, url: "https://agentfs.cloud" })).url).toBe("https://agentfs.cloud");
    expect((await AgentFS.open({ key: KEY, url: stub.url })).url).toBe(stub.url);
  });
});
