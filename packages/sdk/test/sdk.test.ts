import { expect, test } from "bun:test";

import { BlobError, Bucket, verifyUploadCallback } from "../src/index";

type Call = { readonly method: string; readonly url: URL; readonly headers: Headers; readonly body: BodyInit | null | undefined };

const file = (path: string, extra: Record<string, unknown> = {}) => ({
  id: `f_${path.replaceAll("/", "_")}`,
  name: path.split("/").at(-1),
  path,
  content_type: "text/plain",
  size_bytes: 5,
  etag: '"e1"',
  visibility: "unlisted",
  url: `https://f.agentfsusercontent.com/p/p_1/${path.split("/").slice(1).join("/")}`,
  versioned_url: `https://f.agentfsusercontent.com/p/p_1/${path.split("/").slice(1).join("/")}?v=e1`,
  metadata: {},
  created_at: "2026-09-24T00:00:00.000Z",
  updated_at: "2026-09-24T01:00:00.000Z",
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

test("put writes one PUT to the bucket path and returns the blob", async () => {
  const api = fakeApi(() => Response.json(file("site/avatars/me.png", { content_type: "image/png", cache: "immutable" }), { status: 201 }));
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  const blob = await bucket.put("avatars/me.png", new Uint8Array([1, 2, 3]), { contentType: "image/png", cache: "immutable", metadata: { owner: "u7" } });

  expect(blob).toMatchObject({ path: "avatars/me.png", contentType: "image/png", etag: '"e1"', size: 5 });
  expect(blob.versionedUrl).toEndWith("?v=e1");
  const [call] = api.calls;
  expect(call?.method).toBe("PUT");
  expect(call?.url.pathname).toBe("/v1/files/site/avatars/me.png");
  expect(call?.url.searchParams.get("cache")).toBe("immutable");
  expect(JSON.parse(call?.url.searchParams.get("metadata") ?? "{}")).toEqual({ owner: "u7" });
  expect(call?.headers.get("authorization")).toBe("Bearer afs_key");
  expect(call?.headers.get("content-type")).toBe("image/png");
});

test("allowOverwrite: false and ifUnchanged become conditional headers and typed errors", async () => {
  const api = fakeApi((call) => {
    if (call.method === "HEAD") return new Response(null, { headers: { etag: '"there"', "content-length": "42" } });
    return call.headers.get("if-none-match") ? problem(409, "path_exists") : problem(412, "precondition_failed");
  });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch, retry: noWait });
  const exists = await bucket.put("a.txt", "x", { allowOverwrite: false }).catch((error: unknown) => error);
  expect(exists).toMatchObject({ code: "already_exists", message: "a.txt already exists", etag: '"there"', size: 42 });
  const changed = await bucket.put("a.txt", "x", { ifUnchanged: '"old"' }).catch((error: unknown) => error);
  expect(BlobError.is(changed) && changed.code).toBe("conflict");
  expect(api.calls.at(-1)?.headers.get("if-match")).toBe('"old"');
});

test("maxSize and contentTypes are checked before anything is sent", async () => {
  const api = fakeApi(() => Response.json({}));
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  await expect(bucket.put("a.txt", "0123456789", { maxSize: "5b" })).rejects.toMatchObject({ code: "too_large" });
  await expect(bucket.put("a.html", "<p>", { contentType: "text/html", contentTypes: ["image/*"] })).rejects.toMatchObject({ code: "content_type_not_allowed" });
  expect(api.calls).toHaveLength(0);
});

test("a large body goes up in parts through an upload session", async () => {
  const api = fakeApi((call) => {
    if (call.url.pathname === "/v1/uploads") {
      return Response.json({ id: "up_1", status: "active", transport: "worker", part_size: 4, total_parts: 2, uploaded_parts: [] }, { status: 201 });
    }
    if (call.url.pathname.startsWith("/v1/uploads/up_1/parts/")) return Response.json({ part_number: 1 });
    if (call.url.pathname === "/v1/uploads/up_1/complete") return Response.json(file("site/big.bin"));
    return problem(404, "not_found");
  });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  const progress: number[] = [];
  const blob = await bucket.put("big.bin", "12345678", { multipart: true, onProgress: (sent) => progress.push(sent) });

  expect(blob.path).toBe("big.bin");
  expect(api.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
    "POST /v1/uploads",
    "PUT /v1/uploads/up_1/parts/1",
    "PUT /v1/uploads/up_1/parts/2",
    "POST /v1/uploads/up_1/complete",
  ]);
  expect(JSON.parse(String(api.calls[0]?.body))).toMatchObject({ path: "site/big.bin", size_bytes: 8, multipart: true });
  expect(progress.at(-1)).toBe(8);
});

test("without a bucket name the key's default project is the bucket", async () => {
  const api = fakeApi((call) => (call.url.pathname === "/v1/me" ? Response.json({ default_project: "inbox" }) : Response.json(file("inbox/a.txt"))));
  const bucket = new Bucket({ token: "afs_key", fetch: api.fetch });
  expect((await bucket.info("a.txt")).path).toBe("a.txt");
  expect(api.calls[1]?.url.pathname).toBe("/v1/files/inbox/a.txt");
  expect(api.calls[1]?.url.search).toBe("?info");
});

test("list matches a raw prefix and pages with a cursor", async () => {
  const api = fakeApi(() => Response.json({ items: [file("site/avatars/me.png")], next_cursor: "c2" }));
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  const page = await bucket.list({ prefix: "ava", limit: 5000 });
  expect(page.blobs.map((blob) => blob.path)).toEqual(["avatars/me.png"]);
  expect(page.cursor).toBe("c2");
  expect(api.calls[0]?.url.searchParams.get("starts_with")).toBe("site/ava");
  expect(api.calls[0]?.url.searchParams.get("limit")).toBe("1000");
});

test("exists is a HEAD, del takes a path, a list or a prefix", async () => {
  let rounds = 0;
  const api = fakeApi((call) => {
    if (call.method === "HEAD") return new Response(null, { status: call.url.pathname.endsWith("here.txt") ? 200 : 404 });
    if (call.method === "DELETE") return new Response(null, { status: 204 });
    if (String(call.body).includes("starts_with")) rounds += 1;
    return Response.json({ deleted: 1000, has_more: rounds === 1 });
  });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  expect(await bucket.exists("here.txt")).toBe(true);
  expect(await bucket.exists("gone.txt")).toBe(false);
  await bucket.del("a.txt");
  await bucket.del(["a.txt", "b.txt"]);
  await bucket.del({ prefix: "tmp/" });
  const posts = api.calls.filter((call) => call.method === "POST").map((call) => JSON.parse(String(call.body)));
  expect(posts).toEqual([{ paths: ["site/a.txt", "site/b.txt"] }, { starts_with: "site/tmp/" }, { starts_with: "site/tmp/" }]);
  await expect(bucket.del({ prefix: "" })).rejects.toMatchObject({ code: "invalid_input" });
});

test("updateJson retries when another writer got there first", async () => {
  let puts = 0;
  const api = fakeApi((call) => {
    if (call.method === "PUT") {
      puts += 1;
      return puts === 1 ? problem(412, "precondition_failed") : Response.json(file("site/count.json"));
    }
    return new Response(JSON.stringify({ n: puts }), { headers: { etag: `"e${puts}"`, "content-length": "7" } });
  });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch, retry: noWait });
  await bucket.updateJson<{ n: number }>("count.json", (previous) => ({ n: (previous?.n ?? 0) + 1 }));
  const bodies = await Promise.all(api.calls.filter((call) => call.method === "PUT").map((call) => new Response(call.body).text()));
  expect(bodies).toEqual(['{"n":1}', '{"n":2}']);
  expect(api.calls.filter((call) => call.method === "PUT").map((call) => call.headers.get("if-match"))).toEqual(['"e0"', '"e1"']);
});

test("signedReadUrl passes downloadAs and returns a Date", async () => {
  const api = fakeApi(() => Response.json({ url: "https://f.test/f/f_1?dl=Q3.pdf", expires_at: "2026-09-24T02:00:00.000Z" }));
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  const signed = await bucket.signedReadUrl("q3.pdf", { expiresIn: "2m", downloadAs: "Q3.pdf" });
  expect(signed.expiresAt.toISOString()).toBe("2026-09-24T02:00:00.000Z");
  expect(api.calls[0]?.url.pathname).toBe("/v1/files/site/q3.pdf/signed-url");
  expect(JSON.parse(String(api.calls[0]?.body))).toEqual({ expires_in: "120s", download_as: "Q3.pdf" });
});

test("verifyUploadCallback accepts AgentFS's signature and rejects a tampered body", async () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ type: "upload.completed", created_at: "now", data: { file: { id: "f_1", path: "site/a.txt" } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const header = `t=${timestamp},v1=${mac}`;
  expect((await verifyUploadCallback(secret, header, body))?.data.file.path).toBe("site/a.txt");
  expect(await verifyUploadCallback(secret, header, body.replace("a.txt", "b.txt"))).toBeNull();
});

test("get is one request and reads the record from the response headers", async () => {
  const api = fakeApi(() => new Response("hello", {
    headers: {
      "content-type": "text/plain",
      "content-length": "5",
      etag: '"e9"',
      "last-modified": "Thu, 24 Sep 2026 01:00:00 GMT",
      "x-agentfs-path": "site/r%C3%A9sum%C3%A9.txt",
      "x-agentfs-url": "https://f.test/p/p_1/r%C3%A9sum%C3%A9.txt",
      "x-agentfs-meta-owner": "u7",
    },
  }));
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  const blob = await bucket.get("résumé.txt");
  expect(api.calls).toHaveLength(1);
  expect(api.calls[0]?.url.pathname).toBe("/v1/files/site/r%C3%A9sum%C3%A9.txt");
  expect(blob).toMatchObject({ path: "résumé.txt", size: 5, etag: '"e9"', contentType: "text/plain", metadata: { owner: "u7" } });
  expect(blob.versionedUrl).toBe("https://f.test/p/p_1/r%C3%A9sum%C3%A9.txt?v=e9");
  expect(await new Response(blob.body).text()).toBe("hello");
});

test("publicUrl is built from the bucket, without asking for the file", async () => {
  const api = fakeApi(() => Response.json({ id: "p_1", default_visibility: "public", urls: { files: "https://f.test/p/p_1/", sandbox: "https://s.test/p/p_1/" } }));
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  expect(await bucket.publicUrl("avatars/me.png")).toBe("https://f.test/p/p_1/avatars/me.png");
  expect(await bucket.publicUrl("pages/index.html")).toBe("https://s.test/p/p_1/pages/index.html");
  expect(api.calls).toHaveLength(1);
});

test("contentTypes checks the bytes, not just the label", async () => {
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: fakeApi(() => Response.json({})).fetch });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  await expect(bucket.put("a.pdf", png, { contentType: "application/pdf", contentTypes: ["application/pdf"] })).rejects.toMatchObject({ code: "content_type_not_allowed" });
  await expect(bucket.put("a.png", png, { contentTypes: ["images/*"] })).rejects.toMatchObject({ code: "invalid_content_type_pattern" });
});

test("a stream needs a size or maxSize, like Upstash", async () => {
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: fakeApi(() => Response.json({})).fetch });
  const stream = () => new Blob(["abc"]).stream();
  await expect(bucket.put("a.txt", stream())).rejects.toMatchObject({ code: "length_required" });
  await expect(bucket.put("a.txt", stream(), { maxSize: "2b" })).rejects.toMatchObject({ code: "too_large" });
});

test("large overwrites and upload URLs replace atomically", async () => {
  const api = fakeApi((call) => {
    if (call.url.pathname === "/v1/uploads") return Response.json({ id: "up_2", status: "active", transport: "s3", part_size: 8, total_parts: 1, upload_url: "https://r2.test/put", uploaded_parts: [] }, { status: 201 });
    if (call.url.hostname === "r2.test") return new Response(null, { status: 200 });
    if (call.url.pathname.endsWith("/complete")) return Response.json(file("site/big.bin"));
    if (call.url.pathname === "/v1/projects/site") return Response.json({ id: "p_1", default_visibility: "private", urls: { files: "https://f.test/", sandbox: "https://s.test/" } });
    return Response.json({ id: "up_3", status: "active", transport: "s3", part_size: 0, total_parts: 1, upload_url: "https://r2.test/put2", upload_url_expires_at: "2026-09-24T02:00:00.000Z", uploaded_parts: [] }, { status: 201 });
  });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch });
  await bucket.put("big.bin", "12345678", { multipart: true });
  expect(JSON.parse(String(api.calls[0]?.body))).toMatchObject({ if_exists: "replace" });
  const upload = await bucket.signedUploadUrl("scan.pdf");
  expect(upload).toEqual({
    url: "https://r2.test/put2",
    headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=3600" },
    expiresAt: new Date("2026-09-24T02:00:00.000Z"),
  });
  expect(JSON.parse(String(api.calls.at(-1)?.body))).toEqual({ if_exists: "replace", content_type: "application/octet-stream", cache: "private, max-age=3600" });
});

test("s3() hands the AWS SDK an endpoint and refreshing credentials", async () => {
  let minted = 0;
  const api = fakeApi(() => {
    minted += 1;
    return Response.json({
      access_key_id: `AFS${minted}`, secret_access_key: "secret", session_token: "afss_token",
      expiration: new Date(Date.now() + (minted === 1 ? 20_000 : 3_600_000)).toISOString(),
      endpoint: "https://agentfs.cloud/s3", region: "auto",
    }, { status: 201 });
  });
  const config = new Bucket({ token: "afs_key", bucket: "site", fetch: api.fetch }).s3();
  expect(config).toMatchObject({ region: "auto", bucket: "site", forcePathStyle: true });
  expect((await config.endpoint()).url.href).toBe("https://agentfs.cloud/s3");
  expect((await config.credentials()).accessKeyId).toBe("AFS2");
  expect((await config.credentials()).accessKeyId).toBe("AFS2");
  expect(minted).toBe(2);
  expect(() => new Bucket({ token: "afs_key", fetch: api.fetch }).s3()).toThrow();
});
