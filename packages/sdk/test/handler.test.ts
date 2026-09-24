import { afterEach, expect, test } from "bun:test";

import { upload, uploadThroughServer } from "../src/browser";
import { Bucket, uploadHandler } from "../src/index";

const realFetch = globalThis.fetch;
const viaGlobal = Object.assign((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), { preconnect: realFetch.preconnect });
afterEach(() => {
  globalThis.fetch = realFetch;
});

const stored = (path: string, size: number) => ({
  id: "f_1", name: path.split("/").at(-1), path, content_type: "text/plain", size_bytes: size, etag: '"e1"',
  visibility: "unlisted", url: `https://f.test/p/p_1/${path.split("/").slice(1).join("/")}`, versioned_url: null,
  metadata: {}, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z",
});

const session = (extra: Record<string, unknown>) => ({ id: "up_1", status: "active", transport: "s3", uploaded_parts: [], ...extra });

const world = (agentfs: (request: Request) => Response | Promise<Response>, handler: { POST: (r: Request) => Promise<Response>; GET: (r: Request) => Promise<Response> }) => {
  const storage: string[] = [];
  const api: string[] = [];
  const route = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host === "app.test") return request.method === "GET" ? handler.GET(request) : handler.POST(request);
    if (url.host === "r2.test") {
      storage.push(`${request.method} ${url.pathname} ${(await request.arrayBuffer()).byteLength}`);
      return new Response(null, { status: 200, headers: { etag: '"part"' } });
    }
    api.push(`${request.method} ${url.pathname}${url.search}`);
    return agentfs(request);
  };
  globalThis.fetch = Object.assign(route, { preconnect: realFetch.preconnect });
  return { storage, api, fetch: globalThis.fetch };
};

test("a browser upload runs begin, one PUT to storage, and end with onUploadComplete's data", async () => {
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: viaGlobal });
  const seen: unknown[] = [];
  const handler = uploadHandler({
    bucket,
    constraints: { maxSize: "1kb", contentTypes: ["text/plain"] },
    context: (request: Request) => ({ user: request.headers.get("x-user") ?? "anon" }),
    onBeforeUpload: ({ ctx, file }) => ({ path: `docs/${ctx.user}/${file.name}`, metadata: { owner: ctx.user } }),
    onUploadComplete: ({ path, ctx, metadata }) => {
      seen.push({ path, user: ctx.user, metadata });
      return { saved: true };
    },
  });
  const io = world((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/uploads") return Response.json(session({ part_size: 5, total_parts: 1, upload_url: "https://r2.test/one" }), { status: 201 });
    if (url.pathname === "/v1/uploads/up_1") return Response.json(session({ part_size: 5, total_parts: 1, expected_size_bytes: 5, upload_url: "https://r2.test/one" }));
    if (url.pathname === "/v1/uploads/up_1/complete") return Response.json(stored("site/docs/u7/a.txt", 5));
    return new Response(null, { status: 404 });
  }, handler);

  const task = upload(new File(["hello"], "a.txt", { type: "text/plain" }), { route: "https://app.test/api/upload", headers: () => ({ "x-user": "u7" }) });
  const done = await task.done;
  expect(done).toMatchObject({ path: "docs/u7/a.txt", size: 5, data: { saved: true } });
  expect(task.snapshot()).toMatchObject({ status: "done", percent: 100 });
  expect(io.storage).toEqual(["PUT /one 5"]);
  expect(seen).toEqual([{ path: "docs/u7/a.txt", user: "u7", metadata: { owner: "u7" } }]);
  const created = io.api.find((call) => call === "POST /v1/uploads");
  expect(created).toBeDefined();
});

test("a large file goes up in parallel parts and a refused file never reaches storage", async () => {
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: viaGlobal });
  const handler = uploadHandler({ bucket, multipart: true, constraints: { maxSize: "10b" }, onBeforeUpload: ({ file }) => ({ path: file.name }) });
  const io = world((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/uploads") return Response.json(session({ part_size: 4, total_parts: 2 }), { status: 201 });
    if (url.pathname === "/v1/uploads/up_1") return Response.json(session({ part_size: 4, total_parts: 2, expected_size_bytes: 8 }));
    if (url.pathname === "/v1/uploads/up_1/part-urls") return Response.json({ parts: [{ part_number: 1, url: "https://r2.test/p1" }, { part_number: 2, url: "https://r2.test/p2" }] });
    if (url.pathname === "/v1/uploads/up_1/complete") return Response.json(stored("site/big.bin", 8));
    return new Response(null, { status: 404 });
  }, handler);

  const done = await upload(new File(["12345678"], "big.bin"), { route: "https://app.test/api/upload" }).done;
  expect(done.path).toBe("big.bin");
  expect(io.storage.sort()).toEqual(["PUT /p1 4", "PUT /p2 4"]);

  const refused = upload(new File(["0123456789ab"], "huge.bin"), { route: "https://app.test/api/upload" });
  await expect(refused.done).rejects.toMatchObject({ code: "too_large" });
  expect(io.storage).toHaveLength(2);

  const constraints = await (await globalThis.fetch("https://app.test/api/upload")).json();
  expect(constraints).toEqual({ constraints: { maxSize: 10 } });
});

test("a proxied route streams the file through your server into put()", async () => {
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: viaGlobal });
  const handler = uploadHandler({
    bucket,
    routes: { avatar: { proxy: true, constraints: { maxSize: "1kb" }, onBeforeUpload: ({ file }) => ({ path: `avatars/${file.name}` }), onUploadComplete: () => ({ ok: 1 }) } },
  });
  const io = world((request) => {
    const url = new URL(request.url);
    if (request.method === "PUT" && url.pathname === "/v1/files/site/avatars/me.png") return Response.json(stored("site/avatars/me.png", 3), { status: 201 });
    return new Response(null, { status: 404 });
  }, handler);
  const done = await uploadThroughServer(new File(["png"], "me.png", { type: "image/png" }), { route: "https://app.test/api/upload?route=avatar" }).done;
  expect(done).toMatchObject({ path: "avatars/me.png", data: { ok: 1 } });
  expect(io.api.map((call) => call.split("?")[0])).toEqual(["PUT /v1/files/site/avatars/me.png"]);
});
