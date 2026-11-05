import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { runner, start } from "./cli";

const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

type Guard = { path: string; ifMatch?: string; ifNoneMatch?: boolean };

const servers: { stop: (force: boolean) => unknown }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

const fakeRemote = (seed: Record<string, string>) => {
  const files = new Map(Object.entries(seed).map(([path, text]) => [path, encode(text)]));
  const events: { id: string; path: string }[] = [];
  const held: (() => void)[] = [];
  const guards: Guard[] = [];
  const requests: Headers[] = [];
  const deleteGuards: { path: string; ifMatch: string | null }[] = [];
  const writers = new Map<string, () => void>();
  const shaOf = (path: string) => {
    const bytes = files.get(path);
    return bytes === undefined ? undefined : new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  };
  const record = (path: string) => {
    events.push({ id: String(events.length + 1), path });
    for (const release of held.splice(0)) release();
  };
  const entry = (path: string, request: Request) => {
    const bytes = files.get(path) ?? new Uint8Array();
    return {
      path,
      size: bytes.length,
      sha256: shaOf(path) ?? "",
      contentType: "text/plain",
      agent: null,
      session: null,
      commit: null,
      updatedAt: "2026-10-29T00:00:00.000Z",
      expiresAt: null,
      verified: true,
      url: new URL(`/blob/${path}`, request.url).href,
    };
  };
  const eventBody = (event: { id: string; path: string }) => ({
    id: event.id,
    at: "2026-10-29T00:00:00.000Z",
    op: "put",
    path: event.path,
    from: null,
    sha256: null,
    size: null,
    agent: null,
    session: null,
    commit: null,
    name: null,
    input: null,
    output: null,
    status: null,
    durationMs: null,
  });
  const pathOf = (request: Request, prefix: string) =>
    decodeURIComponent(new URL(request.url).pathname.slice(prefix.length));
  const server = Bun.serve({
    port: 0,
    routes: {
      "/v1/signup": { POST: () => Response.json({ key: "afs_TestTestTestTestTestTestTestTest" }, { status: 201 }) },
      "/v1/limits": () =>
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
      "/v1/files": {
        GET: (request) => {
          requests.push(request.headers);
          const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
          const listed = [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => entry(path, request));
          return Response.json({ files: listed, folders: [], cursor: null });
        },
        POST: async (request) => {
          requests.push(request.headers);
          const wanted: { files: (Guard & { sha256: string })[] } = await request.json();
          const answers = wanted.files.map((item) => {
            guards.push({ path: item.path, ...(item.ifMatch === undefined ? {} : { ifMatch: item.ifMatch }), ...(item.ifNoneMatch === undefined ? {} : { ifNoneMatch: item.ifNoneMatch }) });
            const current = shaOf(item.path);
            if (current === item.sha256) return { ...entry(item.path, request), status: "unchanged" };
            const refused = (item.ifNoneMatch === true && current !== undefined) || (item.ifMatch !== undefined && item.ifMatch !== current);
            return { path: item.path, status: refused ? "conflict" : "missing", current: current ?? null };
          });
          return Response.json({ files: answers });
        },
      },
      "/v1/files/*": {
        PUT: async (request) => {
          const path = pathOf(request, "/v1/files/");
          const current = shaOf(path);
          const ifMatch = request.headers.get("if-match");
          const refused = (request.headers.get("if-none-match") === "*" && current !== undefined) || (ifMatch !== null && ifMatch !== `"${current}"`);
          if (refused) {
            const error = { code: "precondition_failed", message: "the file changed", retryAfter: null };
            return Response.json({ error }, { status: 412 });
          }
          files.set(path, new Uint8Array(await request.arrayBuffer()));
          record(path);
          writers.get(path)?.();
          return Response.json({ ...entry(path, request), status: "uploaded" });
        },
        HEAD: (request) => {
          const path = pathOf(request, "/v1/files/");
          const sha = shaOf(path);
          if (sha === undefined) return new Response(null, { status: 404 });
          const { url, size } = entry(path, request);
          const headers = {
            etag: `"${sha}"`,
            "content-length": String(size),
            "content-type": "text/plain",
            "last-modified": "Thu, 29 Oct 2026 00:00:00 GMT",
            "x-agentfs-verified": "true",
            "x-agentfs-url": url,
          };
          return new Response(null, { headers });
        },
        DELETE: (request) => {
          const path = pathOf(request, "/v1/files/");
          const ifMatch = request.headers.get("if-match");
          deleteGuards.push({ path, ifMatch });
          if (ifMatch !== null && ifMatch !== `"${shaOf(path)}"`) {
            const error = { code: "precondition_failed", message: "the file changed", retryAfter: null };
            return Response.json({ error }, { status: 412 });
          }
          files.delete(path);
          record(path);
          return new Response(null, { status: 204 });
        },
      },
      "/blob/*": (request) => {
        requests.push(request.headers);
        return new Response(files.get(pathOf(request, "/blob/"))?.slice());
      },
      "/v1/events": (request) => {
        requests.push(request.headers);
        const query = new URL(request.url).searchParams;
        const prefix = query.get("path") ?? "";
        const after = query.get("after");
        const inPrefix = () => events.filter((event) => event.path.startsWith(prefix));
        if (after === null) {
          return Response.json({ events: inPrefix().toReversed().map(eventBody), cursor: null });
        }
        const fresh = () => inPrefix().filter((event) => Number(event.id) > Number(after));
        const answer = () => {
          const found = fresh();
          return Response.json({ events: found.map(eventBody), cursor: found.at(-1)?.id ?? after });
        };
        if (fresh().length > 0 || Number(query.get("wait") ?? "0") === 0) return answer();
        return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
      },
    },
  });
  servers.push(server);
  return {
    server,
    guards,
    requests,
    deleteGuards,
    putQuietly: (path: string, text: string) => {
      files.set(path, encode(text));
    },
    put: (path: string, text: string) => {
      files.set(path, encode(text));
      record(path);
    },
    remove: (path: string) => {
      files.delete(path);
      record(path);
    },
    text: (path: string) => (files.has(path) ? new TextDecoder().decode(files.get(path)) : undefined),
    paths: () => [...files.keys()].toSorted(),
    written: (path: string) => new Promise<void>((resolve) => writers.set(path, resolve)),
  };
};

const setup = async (seed: Record<string, string>) => {
  const remote = fakeRemote(seed);
  const config = await mkdtemp(join(tmpdir(), "agentfs-config-"));
  const dir = await mkdtemp(join(tmpdir(), "agentfs-sync-"));
  return { remote, dir, config, run: runner(remote.server, config) };
};

const read = (dir: string, name: string) => readFile(join(dir, name), "utf8");

test("sync pulls what is remote, then pushes a local edit with If-Match on the last synced sha", async () => {
  const { remote, dir, run } = await setup({ "docs/a.txt": "v1", "docs/b.txt": "b1" });
  const first = await run("sync", dir, "docs");
  expect(first.code).toBe(0);
  expect(first.stdout.split("\n").toSorted()).toEqual(["", "pulled\ta.txt", "pulled\tb.txt"]);
  expect(await read(dir, "a.txt")).toBe("v1");

  await writeFile(join(dir, "a.txt"), "v2");
  await writeFile(join(dir, "c.txt"), "new file");
  const second = await run("sync", dir, "docs");
  expect(second.code).toBe(0);
  expect(second.stdout.split("\n").toSorted()).toEqual(["", "pushed\ta.txt", "pushed\tc.txt"]);
  expect(remote.text("docs/a.txt")).toBe("v2");
  expect(remote.text("docs/c.txt")).toBe("new file");
  expect(remote.guards.filter(({ path }) => path === "docs/a.txt").at(-1)).toEqual({ path: "docs/a.txt", ifMatch: sha256("v1") });
  expect(remote.guards.filter(({ path }) => path === "docs/c.txt").at(-1)).toEqual({ path: "docs/c.txt", ifNoneMatch: true });
  expect(remote.paths()).toEqual(["docs/a.txt", "docs/b.txt", "docs/c.txt"]);
});

test("sync pulls a remote edit into the local file", async () => {
  const { remote, dir, run } = await setup({ "docs/a.txt": "v1" });
  await run("sync", dir, "docs");
  remote.put("docs/a.txt", "v2 from elsewhere");
  const result = await run("sync", dir, "docs");
  expect(result.stdout).toBe("pulled\ta.txt\n");
  expect(await read(dir, "a.txt")).toBe("v2 from elsewhere");
});

test("sync deletes on the other side what one side deleted after it was synced", async () => {
  const { remote, dir, run } = await setup({ "docs/a.txt": "a", "docs/b.txt": "b" });
  await run("sync", dir, "docs");
  await rm(join(dir, "a.txt"));
  remote.remove("docs/b.txt");
  const result = await run("sync", dir, "docs");
  expect(result.stdout.split("\n").toSorted()).toEqual(["", "deleted-local\tb.txt", "deleted-remote\ta.txt"]);
  expect(remote.paths()).toEqual([]);
  expect((await readdir(dir)).toSorted()).toEqual([".agentfs"]);
  expect(remote.deleteGuards.filter(({ path }) => path === "docs/a.txt")).toEqual([
    { path: "docs/a.txt", ifMatch: `"${sha256("a")}"` },
  ]);
});

test("a remote delete that finds the file changed under it pulls the remote edit instead", async () => {
  const { remote, dir, run } = await setup({ "docs/a.txt": "v1" });
  await run("sync", dir, "docs");
  await rm(join(dir, "a.txt"));
  remote.putQuietly("docs/a.txt", "edited without an event");
  const result = await run("sync", dir, "docs");
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("pulled\ta.txt\n");
  expect(await read(dir, "a.txt")).toBe("edited without an event");
  expect(remote.text("docs/a.txt")).toBe("edited without an event");
});

test("when both sides changed a file the local one is kept, the remote one lands beside it, and exit is 3", async () => {
  const { remote, dir, run } = await setup({ "docs/a.txt": "v1" });
  await run("sync", dir, "docs");
  await writeFile(join(dir, "a.txt"), "local edit");
  remote.put("docs/a.txt", "remote edit");

  const clash = await run("sync", dir, "docs");
  expect(clash.code).toBe(3);
  expect(clash.stdout).toBe("conflict\ta.txt\ta.remote.txt\n");
  expect(await read(dir, "a.txt")).toBe("local edit");
  expect(await read(dir, "a.remote.txt")).toBe("remote edit");
  expect(remote.text("docs/a.txt")).toBe("remote edit");

  const again = await run("sync", dir, "docs");
  expect(again.code).toBe(3);

  await writeFile(join(dir, "a.txt"), "merged");
  const resolved = await run("sync", dir, "docs");
  expect(resolved.code).toBe(0);
  expect(resolved.stdout).toBe("pushed\ta.txt\n");
  expect(remote.text("docs/a.txt")).toBe("merged");
  expect(remote.paths()).toEqual(["docs/a.txt"]);
  expect((await readdir(dir)).toSorted()).toEqual([".agentfs", "a.txt"]);
});

test("sync --watch pushes a local write and pulls a remote one within a second, and stops cleanly on Ctrl-C", async () => {
  const { remote, dir, config } = await setup({ "docs/a.txt": "v1" });
  const child = start(remote.server, config, ["sync", dir, "docs", "--watch"]);
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let log = "";
  const passes = async (summary: string, count: number) => {
    while (log.split(summary).length - 1 < count) {
      const { value, done } = await reader.read();
      if (done) break;
      log += decoder.decode(value);
    }
  };
  const within = async (work: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("not done within a second")), 1000);
    });
    await Promise.race([work, deadline]);
    clearTimeout(timer);
  };
  await passes("1 pulled in", 1);

  await writeFile(join(dir, "new.txt"), "written while watching");
  await within(remote.written("docs/new.txt"));
  expect(remote.text("docs/new.txt")).toBe("written while watching");

  remote.put("docs/from-remote.txt", "written elsewhere");
  await within(passes("1 pulled in", 2));
  expect(await read(dir, "from-remote.txt")).toBe("written elsewhere");

  child.kill("SIGINT");
  expect(await child.exited).toBe(0);
});

test("every request carries the CLI user agent and the agent attribution, and sync adds its command", async () => {
  const { remote, dir, run } = await setup({ "docs/a.txt": "v1" });
  process.env.AGENTFS_AGENT = "tester";
  try {
    await run("sync", dir, "docs");
    const fromSync = remote.requests.splice(0);
    expect(fromSync.length).toBe(3);
    for (const headers of fromSync) {
      expect(headers.get("user-agent")).toBe(`agentfs-cli/${version}`);
      expect(headers.get("x-agentfs-command")).toBe("sync");
    }
    for (const headers of fromSync.filter((headers) => headers.has("authorization"))) {
      expect(headers.get("x-agentfs-agent")).toBe("tester");
    }

    await run("ls", "docs");
    const fromLs = remote.requests.splice(0);
    expect(fromLs.length).toBe(1);
    expect(fromLs[0]?.get("user-agent")).toBe(`agentfs-cli/${version}`);
    expect(fromLs[0]?.get("x-agentfs-command")).toBeNull();
    expect(fromLs[0]?.get("x-agentfs-agent")).toBe("tester");
  } finally {
    delete process.env.AGENTFS_AGENT;
  }
});
