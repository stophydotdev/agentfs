import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runner } from "./cli";

const wanted = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string(),
      size: z.number(),
      ttlSeconds: z.number().optional(),
      ifMatch: z.string().optional(),
      ifNoneMatch: z.boolean().optional(),
    }),
  ),
});

const MB = 1024 * 1024;
const PART_BYTES = 32 * MB;
// The CLI sends a file in parts above 90 MB, whatever the plan. This one is the first size that does.
const BIG_BYTES = 90 * MB + 1;
const plan = { name: "pro", maxFileBytes: 800 * 1024 * MB };

const bigBody = (tag: string, size = BIG_BYTES) => {
  const bytes = Buffer.alloc(size);
  bytes.write(tag);
  return bytes;
};
const sha256Of = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const blobs = new Map<string, ArrayBuffer>();
const files = new Map<string, string>();
const uploads: string[] = [];
const parts = new Map<number, ArrayBuffer>();
const changeAfterLink = new Set<string>();
const changeAfterConflict = new Set<string>();
const linkKeys: string[] = [];
const inProgressOnce = { armed: false };
const expiries = new Map<string, string | null>();
const partWrites: number[] = [];
const partAuthorizations: (string | null)[] = [];
const partFailures = new Map<number, number>();
const started: string[] = [];
const completed: { partNumber: number; etag: string }[][] = [];

const preconditionFailed = (request: Request, path: string) => {
  const remote = files.get(path);
  const exists = request.headers.get("if-none-match") === "*" && remote !== undefined;
  const ifMatch = request.headers.get("if-match");
  if (!exists && (ifMatch === null || ifMatch === `"${remote}"`)) return null;
  const error = { code: "precondition_failed", message: "the file changed", retryAfter: null };
  return Response.json({ error }, { status: 412 });
};

const entryOf = (path: string, sha256: string, request: Request) => ({
  path,
  sha256,
  size: blobs.get(sha256)?.byteLength ?? 0,
  contentType: "application/octet-stream",
  agent: null,
  session: null,
  commit: null,
  updatedAt: "2026-10-29T00:00:00.000Z",
  expiresAt: null,
  verified: true,
  url: new URL(`/files/${path}`, request.url).href,
});

const server = Bun.serve({
  port: 0,
  routes: {
    "/v1/signup": { POST: () => Response.json({ key: "afs_test" }, { status: 201 }) },
    "/v1/files": {
      GET: (request) => {
        const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
        const listed = Array.from(files)
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, sha256]) => entryOf(path, sha256, request));
        return Response.json({ files: listed, folders: [], cursor: null });
      },
      POST: async (request) => {
        linkKeys.push(request.headers.get("idempotency-key") ?? "");
        if (inProgressOnce.armed) {
          inProgressOnce.armed = false;
          const error = { code: "idempotency_in_progress", message: "still running", retryAfter: 0, requestId: "r1" };
          return Response.json({ error }, { status: 409 });
        }
        const answers = wanted.parse(await request.json()).files.map(({ path, sha256, ttlSeconds, ifMatch, ifNoneMatch }) => {
          const remote = files.get(path);
          if (remote === sha256) return { ...entryOf(path, sha256, request), status: "unchanged" };
          if ((ifNoneMatch === true && remote !== undefined) || (ifMatch !== undefined && ifMatch !== remote)) {
            if (changeAfterConflict.has(path)) files.set(path, "changed-remotely");
            return { path, status: "conflict", current: remote ?? null };
          }
          if (!blobs.has(sha256)) {
            const current = files.get(path) ?? null;
            if (changeAfterLink.has(path)) files.set(path, "changed-remotely");
            expiries.set(path, ttlSeconds === undefined ? null : String(ttlSeconds));
            return { path, status: "missing", current };
          }
          files.set(path, sha256);
          expiries.set(path, ttlSeconds === undefined ? null : String(ttlSeconds));
          return { ...entryOf(path, sha256, request), status: "linked" };
        });
        return Response.json({ files: answers });
      },
    },
    "/v1/files/*": {
      PUT: async (request) => {
        const path = decodeURIComponent(new URL(request.url).pathname.slice("/v1/files/".length));
        const refused = preconditionFailed(request, path);
        if (refused !== null) return refused;
        expiries.set(path, request.headers.get("x-agentfs-ttl"));
        const sha256 = request.headers.get("x-sha256") ?? "";
        blobs.set(sha256, await request.arrayBuffer());
        files.set(path, sha256);
        uploads.push(path);
        return Response.json({ ...entryOf(path, sha256, request), status: "uploaded" });
      },
    },
    "/v1/limits": () =>
      Response.json({
        key: { id: "key_1", scoped: false, prefix: "", permissions: ["read", "write", "delete"], expiresAt: null },
        plan: plan.name,
        tier: "unclaimed",
        ownerUsedBytes: null,
        ownerLimitBytes: null,
        usedBytes: 0,
        files: 0,
        capBytes: 1e10,
        owner: null,
        expiresAt: null,
        maxCapBytes: 1e10,
        maxFileBytes: plan.maxFileBytes,
        maxMultipartBytes: PART_BYTES * 10_000,
        partBytes: PART_BYTES,
        maxBatchFiles: 1000,
        parallelUploads: 32,
      }),
    "/v1/uploads": {
      POST: async (request) => {
        const { path } = z.object({ path: z.string() }).parse(await request.json());
        expiries.set(path, request.headers.get("x-agentfs-ttl"));
        started.push(path);
        return Response.json(
          { upload: crypto.randomUUID(), uploadId: "upload-1", partBytes: PART_BYTES },
          { status: 201 },
        );
      },
    },
    "/v1/uploads/*": async (request) => {
      const url = new URL(request.url);
      const [, uploadId = "", last = ""] = url.pathname.split("/").slice(3);
      if (uploadId === "stale") {
        const error = { code: "upload_failed", message: "gone", retryAfter: null };
        return Response.json({ error }, { status: 409 });
      }
      if (request.method === "PUT") {
        const partNumber = Number(last);
        partAuthorizations.push(request.headers.get("authorization"));
        const failuresLeft = partFailures.get(partNumber) ?? 0;
        if (failuresLeft > 0) {
          partFailures.set(partNumber, failuresLeft - 1);
          return new Response("storage hiccup", { status: 500 });
        }
        parts.set(partNumber, await request.arrayBuffer());
        partWrites.push(partNumber);
        return Response.json({ partNumber, etag: `"etag-${partNumber}"` });
      }
      const { path, sha256, parts: listed } = z
        .object({
          path: z.string(),
          sha256: z.string(),
          parts: z.array(z.object({ partNumber: z.number(), etag: z.string() })),
        })
        .parse(await request.json());
      const refused = preconditionFailed(request, path);
      if (refused !== null) return refused;
      completed.push(listed);
      const ordered = Array.from(parts).toSorted(([a], [b]) => a - b);
      blobs.set(sha256, await new Blob(ordered.map(([, bytes]) => bytes)).arrayBuffer());
      files.set(path, sha256);
      uploads.push(path);
      return Response.json({ ...entryOf(path, sha256, request), verified: false, status: "uploaded" });
    },
    "/files/*": (request) => {
      const path = decodeURIComponent(new URL(request.url).pathname.slice("/files/".length));
      const blob = blobs.get(files.get(path) ?? "");
      return blob === undefined ? new Response(null, { status: 404 }) : new Response(blob);
    },
  },
});
afterAll(() => server.stop());
const scratch: string[] = [];
const scratchDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  for (const [sha256, bytes] of blobs) if (bytes.byteLength > MB) blobs.delete(sha256);
  plan.name = "pro";
  plan.maxFileBytes = 800 * 1024 * MB;
});

const config = await mkdtemp(join(tmpdir(), "agentfs-config-"));
afterAll(() => rm(config, { recursive: true, force: true }));

const agentfs = runner(server, config);

const makeFolder = async (name: string, contents: Record<string, string | Uint8Array>) => {
  const folder = join(await scratchDir("agentfs-put-"), name);
  await Promise.all(
    Object.entries(contents).map(async ([path, body]) => {
      await mkdir(join(folder, path, ".."), { recursive: true });
      await writeFile(join(folder, path), body);
    }),
  );
  return folder;
};

test("a second upload of the same folder sends only the files that changed", async () => {
  uploads.length = 0;
  const folder = await makeFolder("report", {
    "index.html": "<h1>run</h1>",
    "img/chart.png": "png",
    "notes.md": "# notes",
  });
  const first = await agentfs("put", folder);
  expect(first.code).toBe(0);
  expect(uploads.toSorted()).toEqual(["report/img/chart.png", "report/index.html", "report/notes.md"]);

  uploads.length = 0;
  await writeFile(join(folder, "notes.md"), "# notes, edited");
  const second = await agentfs("put", folder);
  expect(uploads).toEqual(["report/notes.md"]);
  expect(second.stderr).toContain("1 uploaded, 2 unchanged");
});

test("piped put prints only the path, the link and the status; --json prints every field", async () => {
  const folder = await makeFolder("brief", { "a.txt": "brief" });
  const piped = await agentfs.piped("put", folder);
  expect(JSON.parse(piped.stdout)).toEqual({
    path: "brief/a.txt",
    url: new URL("/files/brief/a.txt", server.url).href,
    status: "uploaded",
  });
  const full = await agentfs("put", folder, "--json");
  expect(JSON.parse(full.stdout)).toMatchObject({ path: "brief/a.txt", sha256: expect.any(String), status: "unchanged" });
});

test("bytes the account already holds are linked to a new path, not sent again", async () => {
  await agentfs("put", await makeFolder("first", { "data.csv": "a,b\n1,2" }));
  uploads.length = 0;
  const copy = await agentfs("put", await makeFolder("second", { "data.csv": "a,b\n1,2" }));
  expect(uploads).toEqual([]);
  expect(copy.stderr).toContain("1 linked");
});

test("pull downloads a folder and then skips the files it already has", async () => {
  await agentfs("put", await makeFolder("results", { "a.txt": "alpha", "deep/b.txt": "beta" }));
  const into = await scratchDir("agentfs-pull-");

  const first = await agentfs("pull", "results", into);
  expect(first.stderr).toContain("2 downloaded");
  expect(await readFile(join(into, "results", "deep", "b.txt"), "utf8")).toBe("beta");

  const second = await agentfs("pull", "results", into);
  expect(second.stderr).toContain("2 unchanged");
});

test("put skips what .gitignore ignores and files that look like secrets", async () => {
  uploads.length = 0;
  const folder = await makeFolder("app", {
    ".gitignore": "dist/\n",
    "index.html": "<h1>app</h1>",
    "dist/bundle.js": "built",
    ".env": "TOKEN=secret",
  });
  Bun.spawnSync(["git", "init", "-q", folder]);
  const result = await agentfs("put", folder);
  expect(uploads.toSorted()).toEqual(["app/.gitignore", "app/index.html"]);
  expect(result.stderr).toContain("skipped 1 files that look like secrets: app/.env");
});

test("on a plan with an 800 GB file cap, a file above 90 MB goes up in parts and comes back whole", async () => {
  parts.clear();
  const body = bigBody("large");
  await agentfs("put", await makeFolder("large", { "data.bin": body }));
  expect(parts.size).toBe(3);
  const into = await scratchDir("agentfs-pull-");
  await agentfs("pull", "large", into);
  expect(sha256Of(await readFile(join(into, "large", "data.bin")))).toBe(sha256Of(body));
});

test("exactly 90 MB goes up in one request and one byte more goes up in parts", async () => {
  uploads.length = 0;
  started.length = 0;
  const folder = await makeFolder("edge", { "exact.bin": bigBody("exact", 90 * MB), "above.bin": bigBody("above") });
  const result = await agentfs("put", folder);
  expect(result.code).toBe(0);
  expect(uploads.toSorted()).toEqual(["edge/above.bin", "edge/exact.bin"]);
  expect(started).toEqual(["edge/above.bin"]);
});

test("a file above the plan's file cap is refused before any bytes are sent", async () => {
  uploads.length = 0;
  started.length = 0;
  plan.name = "free";
  plan.maxFileBytes = 50 * MB;
  const result = await agentfs("put", await makeFolder("huge", { "data.bin": bigBody("huge", 60 * MB) }));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("error: huge/data.bin: file_too_large: 60 MB is more than the 50 MB one file can be on the free plan. See agentfs limits.");
  expect(uploads).toEqual([]);
  expect(started).toEqual([]);
});

test("a folder that .gitignore ignores is still uploaded when you name it", async () => {
  uploads.length = 0;
  const repo = await makeFolder("site", { ".gitignore": "dist/\n", "dist/index.html": "<h1>built</h1>" });
  Bun.spawnSync(["git", "init", "-q", repo]);
  await agentfs("put", join(repo, "dist"));
  expect(uploads).toEqual(["dist/index.html"]);
});

test("a resume state for an upload the server no longer has starts a new upload", async () => {
  parts.clear();
  const body = bigBody("stale");
  const folder = await makeFolder("stale", { "data.bin": body });
  const sha256 = sha256Of(body);
  const state = { upload: crypto.randomUUID(), uploadId: "stale", partBytes: PART_BYTES, done: [] };
  await mkdir(join(config, "agentfs", "uploads"), { recursive: true });
  await writeFile(join(config, "agentfs", "uploads", `test-${sha256}.json`), JSON.stringify(state));

  const result = await agentfs("put", folder);
  expect(result.stderr).toContain("1 uploaded");
  expect(await readdir(join(config, "agentfs", "uploads"))).toEqual([]);
});

test("put does not overwrite a file that changed remotely, and --force does", async () => {
  parts.clear();
  await agentfs("put", await makeFolder("seed-late", { "x.txt": "late bytes, new" }));
  const folder = await makeFolder("race", {
    "a.txt": "first a",
    "big.txt": bigBody("race big, first"),
    "ok.txt": "first ok",
    "late.txt": "late bytes, old",
  });
  await agentfs("put", folder);
  await Promise.all([
    writeFile(join(folder, "a.txt"), "second a"),
    writeFile(join(folder, "big.txt"), bigBody("race big, second")),
    writeFile(join(folder, "ok.txt"), "second ok"),
    writeFile(join(folder, "late.txt"), "late bytes, new"),
  ]);
  changeAfterLink.add("race/a.txt").add("race/big.txt");
  changeAfterConflict.add("race/late.txt");
  uploads.length = 0;

  const raced = await agentfs("put", folder);
  expect(uploads).toEqual(["race/ok.txt"]);
  expect(raced.code).toBe(3);
  for (const path of ["a.txt", "big.txt", "late.txt"]) {
    expect(raced.stderr).toContain(`conflict: race/${path}: changed remotely while uploading, not uploaded. Add --force to overwrite.`);
  }
  expect(raced.stderr).toContain("1 uploaded, 3 conflict");

  const forced = await agentfs("put", folder, "--force");
  expect(forced.code).toBe(0);
  expect(uploads.toSorted()).toEqual(["race/a.txt", "race/big.txt", "race/ok.txt"]);
  expect(forced.stderr).toContain("1 linked");
});

test("put retries a request that is still running with the same idempotency key", async () => {
  linkKeys.length = 0;
  inProgressOnce.armed = true;
  const result = await agentfs("put", await makeFolder("again", { "a.txt": "again a" }));
  expect(result.stderr).toContain("1 uploaded");
  expect(linkKeys.length).toBe(2);
  expect(linkKeys[0]).toBe(linkKeys[1]);
  expect(linkKeys[0]).not.toBe("");
});

test("put --ttl sets the expiry on single, multipart and linked files", async () => {
  parts.clear();
  await agentfs("put", await makeFolder("seed", { "data.csv": "known bytes" }));
  expiries.clear();
  const folder = await makeFolder("ttl", {
    "small.txt": "small",
    "big.txt": bigBody("ttl"),
    "known.txt": "known bytes",
  });
  const result = await agentfs("put", folder, "--ttl", "1d");
  expect(result.code).toBe(0);
  expect(Object.fromEntries(expiries)).toEqual({
    "ttl/small.txt": "86400",
    "ttl/big.txt": "86400",
    "ttl/known.txt": "86400",
  });
});

const resetParts = () => {
  parts.clear();
  partWrites.length = 0;
  partAuthorizations.length = 0;
  partFailures.clear();
  started.length = 0;
  completed.length = 0;
};

test("parts go to the API with the key and complete with the ETags as returned", async () => {
  resetParts();
  const result = await agentfs("put", await makeFolder("api", { "data.bin": bigBody("api") }), "--json");
  expect(result.code).toBe(0);
  expect(started).toEqual(["api/data.bin"]);
  expect(partWrites.toSorted()).toEqual([1, 2, 3]);
  expect(partAuthorizations).toEqual(["Bearer afs_test", "Bearer afs_test", "Bearer afs_test"]);
  expect(completed).toEqual([
    [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
    ],
  ]);
  expect(JSON.parse(result.stdout).verified).toBe(false);
});

test("a part the server fails once is sent again and the upload carries on", async () => {
  resetParts();
  partFailures.set(2, 1);
  const result = await agentfs("put", await makeFolder("hiccup", { "data.bin": bigBody("hiccup") }));
  expect(result.code).toBe(0);
  expect(partWrites.toSorted()).toEqual([1, 2, 3]);
  expect(partAuthorizations.length).toBe(4);
});

test("an interrupted upload resumes and sends only the parts that are left", async () => {
  resetParts();
  const body = bigBody("interrupted");
  const folder = await makeFolder("interrupted", { "data.bin": body });
  partFailures.set(3, 3);
  const interrupted = await agentfs("put", folder);
  expect(interrupted.code).toBe(1);
  expect(partWrites.toSorted()).toEqual([1, 2]);
  expect(await readdir(join(config, "agentfs", "uploads"))).toEqual([`test-${sha256Of(body)}.json`]);

  partWrites.length = 0;
  started.length = 0;
  const resumed = await agentfs("put", folder);
  expect(resumed.stderr).toContain("1 uploaded");
  expect(started).toEqual([]);
  expect(partWrites).toEqual([3]);
  expect(completed.at(-1)?.map(({ etag }) => etag)).toEqual(['"etag-1"', '"etag-2"', '"etag-3"']);
  expect(sha256Of(new Uint8Array(blobs.get(sha256Of(body)) ?? new ArrayBuffer(0)))).toBe(sha256Of(body));
  expect(await readdir(join(config, "agentfs", "uploads"))).toEqual([]);
});

test("a resume file an older CLI wrote for storage URLs is ignored and the upload starts again", async () => {
  resetParts();
  const body = bigBody("older");
  const folder = await makeFolder("older", { "data.bin": body });
  const state = {
    upload: crypto.randomUUID(),
    uploadId: "upload-1",
    partBytes: 525 * MB,
    direct: true,
    done: [{ partNumber: 1, etag: '"etag-1"' }],
  };
  await mkdir(join(config, "agentfs", "uploads"), { recursive: true });
  await writeFile(join(config, "agentfs", "uploads", `test-${sha256Of(body)}.json`), JSON.stringify(state));

  const result = await agentfs("put", folder);
  expect(result.stderr).toContain("1 uploaded");
  expect(started).toEqual(["older/data.bin"]);
  expect(partWrites.toSorted()).toEqual([1, 2, 3]);
});
