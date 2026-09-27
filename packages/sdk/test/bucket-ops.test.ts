import { expect, test } from "bun:test";

import { BlobError, Bucket } from "../src/index";

type Call = { readonly method: string; readonly url: URL; readonly headers: Headers; readonly body: BodyInit | null | undefined };

const stored = (path: string, extra: Record<string, unknown> = {}) => ({
  id: "f_1",
  name: path,
  path,
  content_type: "application/json",
  size_bytes: 1,
  etag: '"e1"',
  visibility: "public",
  url: null,
  created_at: "2026-09-24T00:00:00.000Z",
  ...extra,
});

const problem = (status: number, code: string) => Response.json({ code, title: code, status, detail: code, retryable: false }, { status });

const fakeApi = (route: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: new URL(String(input)), headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    return route(call);
  };
  return { calls, fetch: Object.assign(fetch, { preconnect: () => undefined }) };
};

const noWait = { sleep: async () => undefined, random: () => 0 };
const sent = (call: Call | undefined) => JSON.parse(String(call?.body));

test("list asks for byte order", async () => {
  const api = fakeApi(() => Response.json({ items: [], next_cursor: null }));
  await new Bucket({ token: "k", bucket: "site", fetch: api.fetch }).list({ prefix: "a/", limit: 2.7 });
  expect(api.calls[0]?.url.searchParams.get("order")).toBe("path");
  expect(api.calls[0]?.url.searchParams.get("limit")).toBe("2");
});

test("copy and move overwrite the destination", async () => {
  const api = fakeApi(() => Response.json(stored("site/b.txt")));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  await bucket.copy("a.txt", "b.txt", { cache: "1h" });
  await bucket.move("a.txt", "b.txt");
  expect(sent(api.calls[0])).toEqual({ to: "site/b.txt", if_exists: "replace", cache: "3600s" });
  expect(api.calls[1]?.url.pathname).toBe("/v1/files/site/a.txt/move");
  expect(sent(api.calls[1])).toEqual({ to: "site/b.txt", if_exists: "replace" });
});

test("move with overrides copies then deletes, and reports a copy it could not clean up", async () => {
  const api = fakeApi((call) => (call.method === "DELETE" ? problem(403, "forbidden") : Response.json(stored("site/b.txt"))));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  const error = await bucket.move("a.txt", "b.txt", { contentType: "text/plain" }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "move_left_a_copy", message: "Moved a.txt to b.txt but could not delete the source" });
  expect(BlobError.is(error) && BlobError.is(error.cause) && error.cause.code).toBe("forbidden");
  expect(api.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["POST /v1/files/site/a.txt/copy", "DELETE /v1/files/site/a.txt"]);
  expect(sent(api.calls[0])).toMatchObject({ if_exists: "replace", content_type: "text/plain" });
});

test("updateJson keeps metadata, reads an empty object as null, and gives up with conflict", async () => {
  const seen: unknown[] = [];
  const api = fakeApi((call) => {
    if (call.method === "GET") return new Response("", { headers: { etag: '"e1"', "x-agentfs-meta-owner": "u7" } });
    return problem(412, "precondition_failed");
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch, retry: noWait });
  const error = await bucket.updateJson("doc.json", (previous) => {
    seen.push(previous);
    return { n: 1 };
  }, { maxAttempts: 3 }).catch((caught: unknown) => caught);
  expect(seen).toEqual([null, null, null]);
  expect(error).toMatchObject({ code: "conflict", message: "doc.json kept changing across 3 attempts" });
  expect(BlobError.is(error) && BlobError.is(error.cause)).toBe(true);
  const put = api.calls.find((call) => call.method === "PUT");
  expect(JSON.parse(put?.url.searchParams.get("metadata") ?? "{}")).toEqual({ owner: "u7" });
  await expect(bucket.updateJson("doc.json", () => 1, { maxAttempts: 0 })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(bucket.updateJson("doc.json", () => 1, { maxAttempts: 1.5 })).rejects.toMatchObject({ code: "invalid_input" });
});

test("updateJson backs off from a 25ms base between attempts", async () => {
  const waits: number[] = [];
  const api = fakeApi((call) => (call.method === "GET" ? problem(404, "not_found") : problem(409, "path_exists")));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch, retry: { sleep: async (ms) => void waits.push(ms), random: () => 0.999999 } });
  await expect(bucket.updateJson("doc.json", () => 1, { maxAttempts: 3 })).rejects.toMatchObject({ code: "conflict" });
  expect(waits.filter((ms) => ms > 0)).toEqual([49, 99]);
});

test("a failing delete batch reports the paths that still exist", async () => {
  const api = fakeApi((call) => {
    if (call.method === "HEAD") return new Response(null, { status: call.url.pathname.endsWith("b.txt") ? 200 : 404 });
    return problem(500, "boom");
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch, retry: noWait });
  const error = await bucket.del(["a.txt", "b.txt"]).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "partial_delete", message: "1 of 2 paths were not deleted", failed: ["b.txt"] });
});

test("a failing prefix delete reports what is left under the prefix", async () => {
  const api = fakeApi((call) => {
    if (call.url.pathname === "/v1/files") return Response.json({ items: [stored("site/tmp/x.txt")], next_cursor: null });
    return problem(500, "boom");
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch, retry: noWait });
  await expect(bucket.del({ prefix: "tmp/" })).rejects.toMatchObject({ code: "partial_delete", failed: ["tmp/x.txt"], message: "1 paths under tmp/ were not deleted" });
});

test("deleting a missing path is not an error", async () => {
  const api = fakeApi(() => problem(404, "file_not_found"));
  await new Bucket({ token: "k", bucket: "site", fetch: api.fetch }).del("gone.txt");
});

test("signedUploadUrl returns the headers the upload must send", async () => {
  const api = fakeApi((call) => {
    if (call.url.pathname === "/v1/projects/site") return Response.json({ id: "p_1", default_visibility: "public", urls: { files: "f", sandbox: "s" } });
    return Response.json({ id: "up_1", status: "active", transport: "s3", part_size: 0, total_parts: 1, upload_url: "https://r2.test/put", expires_at: "2026-09-24T02:00:00.000Z" });
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch, cache: "immutable" });
  const upload = await bucket.signedUploadUrl("a.png", { contentType: "image/png", size: "2kb", expiresIn: "10 minutes" });
  expect(upload.headers).toEqual({ "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", "content-length": "2000" });
  expect(sent(api.calls.at(-1))).toMatchObject({ size_bytes: 2000, expires_in: "600s", cache: "public, max-age=31536000, immutable" });
});

test("every duration reaches the server as seconds", async () => {
  const api = fakeApi((call) => {
    if (call.url.pathname === "/v1/upload-tokens") return Response.json({ token: "t", expires_at: "2026-09-24T02:00:00.000Z", path: "site/a", callback_secret: null });
    if (call.url.pathname === "/v1/uploads/abort-stale") return Response.json({ items: [] });
    return Response.json({ url: "https://f.test/x", expires_at: null });
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  await bucket.signedReadUrl("a", { expiresIn: 90 });
  await bucket.abortStaleMultipartUploads({ olderThan: "2 days" });
  await bucket.uploadToken({ path: "a", expiresIn: "1h" });
  expect(api.calls.map((call) => sent(call))).toEqual([
    { expires_in: "90s" },
    { older_than: "172800s" },
    { path: "site/a", expires_in: "3600s" },
  ]);
});

test("get follows a storage redirect without the API key and keeps the API's metadata", async () => {
  const api = fakeApi((call) =>
    call.url.host === "storage.test"
      ? new Response("hello", { headers: { "content-type": "text/plain", "content-length": "5", etag: '"e2"' } })
      : new Response(null, { status: 302, headers: { location: "https://storage.test/obj?sig=1", "x-agentfs-path": "site/a.txt", "x-agentfs-meta-owner": "u7", etag: '"e2"' } }));
  const blob = await new Bucket({ token: "k", bucket: "site", fetch: api.fetch }).get("a.txt");
  expect(await new Response(blob.body).text()).toBe("hello");
  expect(blob).toMatchObject({ path: "a.txt", size: 5, etag: '"e2"', contentType: "text/plain", metadata: { owner: "u7" } });
  expect(api.calls.map((call) => [call.url.host, call.headers.has("authorization")])).toEqual([["agentfs.cloud", true], ["storage.test", false]]);
});

test("get reads the record from info when a redirect carries no metadata", async () => {
  const api = fakeApi((call) => {
    if (call.url.host === "edge.test") return new Response("hello", { headers: { "content-length": "5" } });
    if (call.url.searchParams.has("info")) {
      return Response.json({ id: "f_1", name: "a.txt", path: "site/a.txt", content_type: "text/plain", size_bytes: 5, etag: '"e3"', visibility: "public", url: null, metadata: { owner: "u7" }, created_at: "2026-09-24T00:00:00.000Z" });
    }
    return new Response(null, { status: 302, headers: { location: "https://edge.test/a.txt" } });
  });
  const blob = await new Bucket({ token: "k", bucket: "site", fetch: api.fetch }).get("a.txt");
  expect(blob).toMatchObject({ path: "a.txt", size: 5, etag: '"e3"', contentType: "text/plain", metadata: { owner: "u7" } });
  expect(await new Response(blob.body).text()).toBe("hello");
  expect(api.calls.map((call) => [call.url.host, call.headers.has("authorization")])).toEqual([["agentfs.cloud", true], ["edge.test", false], ["agentfs.cloud", true]]);
});

test("a bucket tags every request with its run and agent, and lists by run", async () => {
  const api = fakeApi((call) => call.method === "PUT"
    ? Response.json(stored("site/out.md", { run_id: "run_7", agent_id: "writer", expires_at: "2026-10-01T00:00:00.000Z" }), { status: 201 })
    : Response.json({ items: [], next_cursor: null }));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch, runId: "run_7", agentId: "writer" });
  const put = await bucket.put("out.md", "hi", { expiresIn: "7d" });
  await bucket.list({ runId: "run_7" });
  expect(api.calls.map((call) => [call.headers.get("x-run-id"), call.headers.get("x-agent-id")])).toEqual([["run_7", "writer"], ["run_7", "writer"]]);
  expect(api.calls[0]?.url.searchParams.get("expires_in")).toBe("604800s");
  expect(api.calls[1]?.url.searchParams.get("run_id")).toBe("run_7");
  expect(put).toMatchObject({ runId: "run_7", agentId: "writer", expiresAt: new Date("2026-10-01T00:00:00.000Z") });
});

test("a full account is storage_full, and grace warnings reach onWarning", async () => {
  const warnings: string[] = [];
  const full = fakeApi(() => problem(413, "storage_limit_exceeded"));
  await expect(new Bucket({ token: "k", bucket: "site", fetch: full.fetch }).put("a.md", "hi")).rejects.toMatchObject({ code: "storage_full" });
  const grace = fakeApi(() => Response.json(stored("site/a.md"), { status: 201, headers: { "agentfs-warning": "storage_over_limit: 2.1 GB used" } }));
  await new Bucket({ token: "k", bucket: "site", fetch: grace.fetch, onWarning: (message) => warnings.push(message) }).put("a.md", "hi");
  expect(warnings).toEqual(["agentfs: storage_over_limit: 2.1 GB used"]);
});
