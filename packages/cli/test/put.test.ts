import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const wanted = z.object({
  files: z.array(z.object({ path: z.string(), sha256: z.string(), size: z.number() })),
});

const PART_BYTES = 16;

const blobs = new Map<string, ArrayBuffer>();
const files = new Map<string, string>();
const uploads: string[] = [];
const parts = new Map<number, ArrayBuffer>();

const entryOf = (path: string, sha256: string, request: Request) => ({
  path,
  sha256,
  size: blobs.get(sha256)?.byteLength ?? 0,
  contentType: "application/octet-stream",
  agent: null,
  session: null,
  commit: null,
  updatedAt: "2026-10-29T00:00:00.000Z",
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
        return Response.json({ files: listed, cursor: null });
      },
      POST: async (request) => {
        const answers = wanted.parse(await request.json()).files.map(({ path, sha256 }) => {
          if (files.get(path) === sha256) return { ...entryOf(path, sha256, request), status: "unchanged" };
          if (!blobs.has(sha256)) return { path, status: "missing" };
          files.set(path, sha256);
          return { ...entryOf(path, sha256, request), status: "linked" };
        });
        return Response.json({ files: answers });
      },
    },
    "/v1/files/*": {
      PUT: async (request) => {
        const path = decodeURIComponent(new URL(request.url).pathname.slice("/v1/files/".length));
        const sha256 = request.headers.get("x-sha256") ?? "";
        blobs.set(sha256, await request.arrayBuffer());
        files.set(path, sha256);
        uploads.push(path);
        return Response.json({ ...entryOf(path, sha256, request), status: "uploaded" });
      },
    },
    "/v1/limits": () =>
      Response.json({
        plan: "free",
        usedBytes: 0,
        files: 0,
        capBytes: 1e10,
        owner: null,
        expiresAt: null,
        maxCapBytes: 1e10,
        maxFileBytes: PART_BYTES,
        maxMultipartBytes: PART_BYTES * 10_000,
        partBytes: PART_BYTES,
        maxBatchFiles: 1000,
        parallelUploads: 32,
      }),
    "/v1/uploads": {
      POST: () => Response.json({ uploadId: "upload-1", partBytes: PART_BYTES }, { status: 201 }),
    },
    "/v1/uploads/*": async (request) => {
      const [sha256 = "", , last = ""] = new URL(request.url).pathname.split("/").slice(3);
      if (last !== "complete") {
        parts.set(Number(last), await request.arrayBuffer());
        return Response.json({ partNumber: Number(last), etag: `etag-${last}` });
      }
      const { path } = z.object({ path: z.string() }).parse(await request.json());
      const ordered = Array.from(parts).toSorted(([a], [b]) => a - b);
      blobs.set(sha256, await new Blob(ordered.map(([, bytes]) => bytes)).arrayBuffer());
      files.set(path, sha256);
      uploads.push(path);
      return Response.json({ ...entryOf(path, sha256, request), status: "uploaded" });
    },
    "/files/*": (request) => {
      const path = decodeURIComponent(new URL(request.url).pathname.slice("/files/".length));
      const blob = blobs.get(files.get(path) ?? "");
      return blob === undefined ? new Response(null, { status: 404 }) : new Response(blob);
    },
  },
});
afterAll(() => server.stop());

const config = await mkdtemp(join(tmpdir(), "agentfs-config-"));

const agentfs = async (...args: string[]) => {
  const run = Bun.spawn(["bun", "src/index.ts", ...args], {
    env: { ...process.env, AGENTFS_URL: server.url.href, XDG_CONFIG_HOME: config },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { stdout, stderr, code };
};

const makeFolder = async (name: string, contents: Record<string, string>) => {
  const folder = join(await mkdtemp(join(tmpdir(), "agentfs-put-")), name);
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

test("bytes the account already holds are linked to a new path, not sent again", async () => {
  await agentfs("put", await makeFolder("first", { "data.csv": "a,b\n1,2" }));
  uploads.length = 0;
  const copy = await agentfs("put", await makeFolder("second", { "data.csv": "a,b\n1,2" }));
  expect(uploads).toEqual([]);
  expect(copy.stderr).toContain("1 linked");
});

test("pull downloads a folder and then skips the files it already has", async () => {
  await agentfs("put", await makeFolder("results", { "a.txt": "alpha", "deep/b.txt": "beta" }));
  const into = await mkdtemp(join(tmpdir(), "agentfs-pull-"));

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

test("a file bigger than one request goes up in parts and comes back whole", async () => {
  parts.clear();
  const body = "a fairly long file that needs three parts";
  await agentfs("put", await makeFolder("large", { "data.txt": body }));
  expect(parts.size).toBe(Math.ceil(body.length / PART_BYTES));
  const into = await mkdtemp(join(tmpdir(), "agentfs-pull-"));
  await agentfs("pull", "large", into);
  expect(await readFile(join(into, "large", "data.txt"), "utf8")).toBe(body);
});
