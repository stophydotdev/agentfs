import { afterEach, expect, setSystemTime, test } from "bun:test";

import { BlobError, Bucket, uploadHandler } from "../src/index";
import type { BeforeUploadResult } from "../src/handler";

const stored = (path: string, size: number) => ({
  id: "f_1", name: path.split("/").at(-1), path, content_type: "text/plain", size_bytes: size, etag: '"e1"',
  visibility: "unlisted", url: `https://f.test/p/p_1/${path.split("/").slice(1).join("/")}`, versioned_url: null,
  metadata: {}, created_at: "2026-09-24T00:00:00.000Z", updated_at: "2026-09-24T00:00:00.000Z",
});

const session = { id: "up_1", status: "active", transport: "s3", uploaded_parts: [], part_size: 5, total_parts: 1, expected_size_bytes: 5, upload_url: "https://r2.test/one" };

afterEach(() => {
  setSystemTime();
});

const agentfs = (complete: () => Response = () => Response.json(stored("site/a.txt", 5))) => {
  const calls: string[] = [];
  const created: unknown[] = [];
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/v1/uploads") {
      created.push(await request.json());
      return Response.json(session, { status: 201 });
    }
    if (url.pathname === "/v1/uploads/up_1") return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(session);
    if (url.pathname === "/v1/uploads/up_1/complete") return complete();
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/files/")) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect });
  return { calls, created, bucket: new Bucket({ token: "afs_key", bucket: "site", fetch }) };
};

const post = (handler: { POST: (request: Request) => Promise<Response> }, body: unknown, route = "") =>
  handler.POST(new Request(`https://app.test/api/upload${route ? `?route=${route}` : ""}`, { method: "POST", body: JSON.stringify(body) }));

const file = (size = 5, type = "text/plain") => ({ name: "a.txt", type, size });

const begin = async (handler: { POST: (request: Request) => Promise<Response> }, route = ""): Promise<string> => {
  const response = await post(handler, { phase: "begin", file: file() }, route);
  const body: { completionToken: string } = await response.json();
  return body.completionToken;
};

test("begin refuses a zero-byte file with empty_body", async () => {
  const { bucket, calls } = agentfs();
  const handler = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt" }) });
  const response = await post(handler, { phase: "begin", file: file(0) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "empty_body", status: 400 });
  expect(calls).toEqual([]);
});

test("onBeforeUpload that returns no path throws a TypeError", async () => {
  const { bucket } = agentfs();
  // @ts-expect-error: the types require an onBeforeUpload; this checks the runtime guard
  const missing = uploadHandler({ bucket, routes: { a: {} } });
  await expect(post(missing, { phase: "begin", file: file() }, "a")).rejects.toThrow(new TypeError("onBeforeUpload must return { path }"));
  const pathless = uploadHandler({ bucket, onBeforeUpload: () => ({}) as BeforeUploadResult });
  await expect(post(pathless, { phase: "begin", file: file() })).rejects.toThrow(new TypeError("onBeforeUpload must return { path }"));
});

test("per-upload constraints may narrow the route's but never widen them", async () => {
  const { bucket } = agentfs();
  const widen = (constraints: BeforeUploadResult["constraints"]) =>
    uploadHandler({ bucket, constraints: { maxSize: "1kb", contentTypes: ["text/plain"] }, onBeforeUpload: () => ({ path: "a.txt", ...(constraints ? { constraints } : {}) }) });
  await expect(post(widen({ maxSize: "2kb" }), { phase: "begin", file: file() })).rejects.toThrow(new TypeError("onBeforeUpload widened maxSize (2000 > 1000)"));
  await expect(post(widen({ contentTypes: ["image/png"] }), { phase: "begin", file: file() })).rejects.toThrow(new TypeError("onBeforeUpload widened contentTypes (image/png)"));
  const narrowed = await post(widen({ maxSize: "4b" }), { phase: "begin", file: file() });
  expect(await narrowed.json()).toMatchObject({ code: "too_large", status: 413 });
});

test("a throwing onUploadComplete deletes the stored file and rethrows", async () => {
  const { bucket, calls } = agentfs();
  const handler = uploadHandler({
    bucket,
    onBeforeUpload: () => ({ path: "a.txt" }),
    onUploadComplete: () => {
      throw new BlobError("forbidden", { message: "not yours" });
    },
  });
  const response = await post(handler, { phase: "end", completionToken: await begin(handler) });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "forbidden", message: "Not yours" });
  expect(calls.at(-1)).toBe("DELETE /v1/files/site/a.txt");
});

test("a completion token only works on the route that minted it, until it expires", async () => {
  const { bucket } = agentfs();
  const handler = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt" }), routes: { a: {}, b: {} } });
  const token = await begin(handler, "a");
  const elsewhere = await post(handler, { phase: "parts", completionToken: token, from: 1 }, "b");
  expect(await elsewhere.json()).toMatchObject({ code: "forbidden", message: "CompletionToken is not valid for this route" });
  const other = uploadHandler({ bucket: agentfs().bucket, onBeforeUpload: () => ({ path: "a.txt" }), routes: { a: {} }, constraints: { maxSize: "1kb" } });
  expect(await (await post(other, { phase: "parts", completionToken: token, from: 1 }, "a")).json()).toMatchObject({ code: "forbidden" });
  setSystemTime(new Date(Date.now() + 25 * 3600 * 1000));
  const expired = await post(handler, { phase: "parts", completionToken: token, from: 1 }, "a");
  expect(expired.status).toBe(403);
  expect(await expired.json()).toMatchObject({ code: "forbidden", message: "CompletionToken has expired" });
});

test("errors leave as BlobError.toJSON and onError can replace them", async () => {
  const { bucket } = agentfs();
  const plain = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt" }) });
  const bad = await post(plain, { phase: "nope" });
  const body: unknown = await bad.json();
  expect(body).toEqual({ code: "invalid_input", message: "Unknown phase nope", status: 400 });
  expect(BlobError.fromJSON(body, bad.status)?.code).toBe("invalid_input");

  const withStatus = uploadHandler({ bucket, onBeforeUpload: () => {
    throw Object.assign(new Error("sign in"), { status: 401 });
  } });
  expect(await (await post(withStatus, { phase: "begin", file: file() })).json()).toEqual({ code: "unauthorized", message: "Sign in", status: 401 });

  const buggy = uploadHandler({ bucket, onBeforeUpload: () => {
    throw new Error("boom");
  } });
  await expect(post(buggy, { phase: "begin", file: file() })).rejects.toThrow("boom");

  const replaced = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt" }), onError: () => new BlobError("rate_limited") });
  expect((await post(replaced, { phase: "nope" })).status).toBe(429);
  const answered = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt" }), onError: () => new Response("teapot", { status: 418 }) });
  expect(await (await post(answered, { phase: "nope" })).text()).toBe("teapot");
});

test("GET serves the constraints with an ETag and answers 304 when it matches", async () => {
  const handler = uploadHandler({ bucket: agentfs().bucket, constraints: { maxSize: "1kb" }, onBeforeUpload: () => ({ path: "a.txt" }) });
  const first = await handler.GET(new Request("https://app.test/api/upload"));
  expect(await first.json()).toEqual({ constraints: { maxSize: 1000 } });
  expect(first.headers.get("content-type")).toBe("application/json");
  expect(first.headers.get("cache-control")).toBe("public, max-age=60");
  const etag = first.headers.get("etag") ?? "";
  expect(etag).toMatch(/^"\w+"$/);
  const again = await handler.GET(new Request("https://app.test/api/upload", { headers: { "if-none-match": etag } }));
  expect(again.status).toBe(304);
  expect((await handler.GET(new Request("https://app.test/api/upload?route=x"))).status).toBe(404);
});

test("a size mismatch at completion is signature_mismatch", async () => {
  const { bucket } = agentfs(() => Response.json({ code: "size_mismatch", detail: "Uploaded parts do not match the declared size." }, { status: 409 }));
  const handler = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt" }) });
  const response = await post(handler, { phase: "end", completionToken: await begin(handler) });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "signature_mismatch" });

  const short = agentfs(() => Response.json(stored("site/a.txt", 4)));
  const shortHandler = uploadHandler({ bucket: short.bucket, onBeforeUpload: () => ({ path: "a.txt" }) });
  const shorted = await post(shortHandler, { phase: "end", completionToken: await begin(shortHandler) });
  expect(await shorted.json()).toMatchObject({ code: "signature_mismatch" });
  expect(short.calls.at(-1)).toBe("DELETE /v1/files/site/a.txt");
});

test("cancel answers { ok: true } and a route without a schema refuses input", async () => {
  const { bucket, calls } = agentfs();
  const handler = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt" }) });
  const cancelled = await post(handler, { phase: "cancel", completionToken: await begin(handler) });
  expect(await cancelled.json()).toEqual({ ok: true });
  expect(calls.at(-1)).toBe("DELETE /v1/uploads/up_1");
  const refused = await post(handler, { phase: "begin", file: file(), input: { a: 1 } });
  expect(await refused.json()).toMatchObject({ code: "invalid_input", message: "This route takes no input" });
});

test("uploadHandler refuses bad route names, an empty routes map and a missing bucket when built", () => {
  const { bucket } = agentfs();
  const onBeforeUpload = () => ({ path: "a.txt" });
  expect(() => uploadHandler({ bucket, onBeforeUpload, routes: {} })).toThrow(new TypeError("uploadHandler was given an empty routes map: name at least one route, or omit routes to make the handler the route"));
  expect(() => uploadHandler({ bucket, onBeforeUpload, routes: { "my route": {} } })).toThrow(new TypeError('upload route names must match /^[A-Za-z_][\\w-]*$/: "my route" does not'));
  const saved = { token: process.env.AGENTFS_KEY, key: process.env.AGENTFS_API_KEY };
  delete process.env.AGENTFS_KEY;
  delete process.env.AGENTFS_API_KEY;
  try {
    expect(() => uploadHandler({ onBeforeUpload })).toThrow(new TypeError("uploadHandler has no bucket and AGENTFS_KEY is not set: set it, or pass bucket (on Workers it has to be bucket: new Bucket({ token: env.AGENTFS_KEY }))"));
    expect(() => uploadHandler({ onBeforeUpload, routes: { avatar: {} } })).toThrow(new TypeError('upload route "avatar" has no bucket and AGENTFS_KEY is not set: set it, or pass bucket (on Workers it has to be bucket: new Bucket({ token: env.AGENTFS_KEY }))'));
  } finally {
    if (saved.token !== undefined) process.env.AGENTFS_KEY = saved.token;
    if (saved.key !== undefined) process.env.AGENTFS_API_KEY = saved.key;
  }
});

test("begin stores the declared type as-is and sends the cache in wire form", async () => {
  const { bucket, created } = agentfs();
  const handler = uploadHandler({ bucket, onBeforeUpload: () => ({ path: "a.txt", cache: "1h" }) });
  await begin(handler);
  await post(handler, { phase: "begin", file: { name: "b.bin", type: "", size: 5 } });
  expect(created).toMatchObject([
    { content_type: "text/plain", infer_content_type: false, cache: "3600s" },
    { content_type: "application/octet-stream", infer_content_type: false },
  ]);
});
