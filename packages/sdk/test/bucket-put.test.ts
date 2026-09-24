import { expect, test } from "bun:test";

import { Bucket } from "../src/index";

type Call = { readonly method: string; readonly url: URL; readonly headers: Headers; readonly body: BodyInit | null | undefined; readonly duplex: unknown };

const stored = (path: string, extra: Record<string, unknown> = {}) => ({
  id: "f_1",
  name: path,
  path,
  content_type: "application/octet-stream",
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
  const fetch = async (input: RequestInfo | URL, init?: RequestInit & { duplex?: unknown }) => {
    const call = { method: init?.method ?? "GET", url: new URL(String(input)), headers: new Headers(init?.headers), body: init?.body, duplex: init?.duplex };
    calls.push(call);
    return route(call);
  };
  return { calls, fetch: Object.assign(fetch, { preconnect: () => undefined }) };
};

const lazyStream = (chunks: readonly Uint8Array[], onPull?: (pulled: number) => void) => {
  let index = 0;
  let pulled = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) return controller.close();
      pulled += chunk.byteLength;
      onPull?.(pulled);
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
};

const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

const session = (extra: Record<string, unknown>) => Response.json({ id: "up_1", status: "active", transport: "worker", uploaded_parts: [], ...extra }, { status: 201 });

test("a stream with a known size goes up as one streamed PUT, never buffered", async () => {
  const api = fakeApi(() => Response.json(stored("site/a.bin")));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  const stream = lazyStream([bytes(3), bytes(2)]);
  await bucket.put("a.bin", stream, { size: 5 });
  const [call] = api.calls;
  expect(call?.body).toBeInstanceOf(ReadableStream);
  expect(call?.duplex).toBe("half");
  expect(call?.headers.get("content-length")).toBe("5");
  expect(call?.headers.get("content-type")).toBe("application/octet-stream");
  expect(call?.url.searchParams.get("infer_content_type")).toBe("false");
  expect((await new Response(call?.body).arrayBuffer()).byteLength).toBe(5);
});

test("a Request streams with its content-length and content-type", async () => {
  const api = fakeApi(() => Response.json(stored("site/r.txt")));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  const request = new Request("https://app.test/upload", { method: "POST", body: "hello", headers: { "content-type": "text/plain", "content-length": "5" } });
  await bucket.put("r.txt", request);
  expect(api.calls[0]?.body).toBeInstanceOf(ReadableStream);
  expect(api.calls[0]?.headers.get("content-type")).toBe("text/plain");
  await expect(bucket.put("r.txt", new Request("https://app.test/", { method: "POST" }))).rejects.toMatchObject({ code: "empty_body" });
});

test("a big stream goes up in parts, reading one part at a time", async () => {
  const pulls: number[] = [];
  let pulled = 0;
  const parts: number[] = [];
  const api = fakeApi(async (call) => {
    if (call.url.pathname === "/v1/uploads") return session({ part_size: 8, total_parts: 3 });
    if (call.url.pathname.includes("/parts/")) {
      pulls.push(pulled);
      parts.push((await new Response(call.body).arrayBuffer()).byteLength);
      return Response.json({});
    }
    return Response.json(stored("site/big.bin"));
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  const stream = lazyStream(Array.from({ length: 10 }, () => bytes(2)), (count) => (pulled = count));
  await bucket.put("big.bin", stream, { size: 20, multipart: "10b" });
  expect(parts).toEqual([8, 8, 4]);
  expect(pulls).toEqual([8, 16, 20]);
  expect(JSON.parse(String(api.calls[0]?.body))).toMatchObject({ size_bytes: 20, multipart: true, if_exists: "replace", infer_content_type: false });
});

test("a stream that is shorter or longer than declared fails and aborts the upload", async () => {
  const api = fakeApi((call) => (call.url.pathname === "/v1/uploads" ? session({ part_size: 4, total_parts: 2 }) : Response.json({})));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  await expect(bucket.put("s.bin", lazyStream([bytes(6)]), { size: 8, multipart: true })).rejects.toMatchObject({ code: "invalid_input", message: "Body was 6 bytes, 8 were declared" });
  expect(api.calls.at(-1)?.method).toBe("DELETE");
  await expect(bucket.put("l.bin", lazyStream([bytes(9)]), { size: 8, multipart: true })).rejects.toMatchObject({ code: "invalid_input", message: "Body is longer than the declared 8 bytes" });
});

test("contentTypes peeks the first bytes without eating them", async () => {
  const api = fakeApi(() => Response.json(stored("site/a.png")));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  await bucket.put("a.png", lazyStream([png.subarray(0, 5), png.subarray(5), bytes(5000)]), { size: 5016, contentType: "image/png", contentTypes: ["image/*"] });
  const sent = new Uint8Array(await new Response(api.calls[0]?.body).arrayBuffer());
  expect(sent.byteLength).toBe(5016);
  expect([...sent.subarray(0, 16)]).toEqual([...png]);
  await expect(bucket.put("a.pdf", lazyStream([png]), { size: 16, contentType: "application/pdf", contentTypes: ["application/pdf"] }))
    .rejects.toMatchObject({ code: "content_type_not_allowed" });
});

test("a stream with only maxSize is buffered up to the cap, like Upstash", async () => {
  const api = fakeApi(() => Response.json(stored("site/a.txt")));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  await bucket.put("a.txt", lazyStream([bytes(3)]), { maxSize: "1kb" });
  expect(api.calls[0]?.body).toBeInstanceOf(Blob);
  expect(api.calls[0]?.headers.get("content-length")).toBe("3");
  await expect(bucket.put("a.txt", lazyStream([bytes(3)]), { size: 3, maxSize: "2b" })).rejects.toMatchObject({ code: "too_large" });
  await expect(bucket.put("a.txt", lazyStream([bytes(3)]))).rejects.toMatchObject({ code: "length_required", status: 411 });
});

test("without contentType the body's own type is sent, else octet-stream", async () => {
  const api = fakeApi(() => Response.json(stored("site/a")));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  await bucket.put("a.json", new Blob(["{}"], { type: "application/json" }));
  await bucket.put("b.html", "<p>");
  expect(api.calls[0]?.headers.get("content-type")).toStartWith("application/json");
  expect(api.calls[1]?.headers.get("content-type")).toBe("application/octet-stream");
});

test("a conditional write over the one-request limit uses a single-PUT session", async () => {
  const api = fakeApi((call) => {
    if (call.url.pathname === "/v1/uploads") return session({ transport: "s3", part_size: 0, total_parts: 1, upload_url: "https://r2.test/put" });
    if (call.url.hostname === "r2.test") return new Response(null);
    return Response.json(stored("site/big.bin"));
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  const size = 150_000_000;
  await bucket.put("big.bin", lazyStream([]), { size, allowOverwrite: false });
  expect(JSON.parse(String(api.calls[0]?.body))).toMatchObject({ size_bytes: size, multipart: false, if_exists: "error", infer_content_type: false });
  expect(api.calls[1]?.headers.get("content-length")).toBe(String(size));
  await bucket.put("big.bin", lazyStream([]), { size, ifUnchanged: '"e1"' });
  expect(JSON.parse(String(api.calls[3]?.body))).toMatchObject({ multipart: false, if_exists: "replace", if_match: '"e1"' });
});

test("conditional multipart and oversize single PUTs are refused before sending", async () => {
  const api = fakeApi(() => problem(500, "boom"));
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  await expect(bucket.put("a", "x", { multipart: true, allowOverwrite: false })).rejects.toMatchObject({
    code: "invalid_input",
    message: "Multipart: allowOverwrite: false and ifUnchanged are single-PUT only",
  });
  const huge = 6 * 1024 ** 3;
  await expect(bucket.put("a", lazyStream([]), { size: huge, multipart: false })).rejects.toMatchObject({ code: "too_large" });
  await expect(bucket.put("a", lazyStream([]), { size: huge, ifUnchanged: '"e"' })).rejects.toMatchObject({ code: "too_large" });
  expect(api.calls).toHaveLength(0);
});

test("a lost conditional session reports already_exists with the object's etag and size", async () => {
  const api = fakeApi((call) => {
    if (call.method === "HEAD") return new Response(null, { headers: { etag: '"now"', "content-length": "9" } });
    return problem(412, "precondition_failed");
  });
  const bucket = new Bucket({ token: "k", bucket: "site", fetch: api.fetch });
  await expect(bucket.put("a.txt", "x", { allowOverwrite: false })).rejects.toMatchObject({ code: "already_exists", etag: '"now"', size: 9 });
});
