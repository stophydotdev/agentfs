import { expect, test } from "bun:test";

import { AgentFSError, createAgentFS } from "../src/index";

type Call = { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: BodyInit | null | undefined };

const file = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: "a.txt",
  path: "reports/a.txt",
  content_type: "text/plain",
  size_bytes: 5,
  visibility: "unlisted",
  url: `https://f.agentfsusercontent.com/f/${id}`,
  expires_at: null,
  created_at: "2026-09-24T00:00:00.000Z",
  ...extra,
});

const fakeApi = (route: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    return route(call);
  };
  return { calls, fetch: Object.assign(fetch, { preconnect: () => undefined }) };
};

const noWait = { sleep: async () => undefined, random: () => 0 };

test("without a key, put sends only the file and no credentials", async () => {
  const api = fakeApi(() => Response.json(file("f_keyless"), { status: 201 }));
  const agentfs = createAgentFS({ fetch: api.fetch });
  const stored = await agentfs.put("reports/a.txt", "hello", { visibility: "private" });
  expect(stored.id).toBe("f_keyless");
  const [call] = api.calls;
  expect(call?.headers.get("authorization")).toBeNull();
  const form = call?.body;
  if (!(form instanceof FormData)) throw new Error("expected a form");
  expect([...form.keys()]).toEqual(["file"]);
});

test("with a key, a small put is one request with path, visibility and run id", async () => {
  const api = fakeApi(() => Response.json(file("f_small"), { status: 201 }));
  const agentfs = createAgentFS({ apiKey: "afs_key", runId: "run_1", fetch: api.fetch });
  await agentfs.put("reports/a.txt", "hello", { visibility: "private", expiresIn: "7d" });
  const [call] = api.calls;
  expect(call?.headers.get("authorization")).toBe("Bearer afs_key");
  expect(call?.headers.get("x-run-id")).toBe("run_1");
  const form = call?.body;
  if (!(form instanceof FormData)) throw new Error("expected a form");
  expect(form.get("path")).toBe("reports/a.txt");
  expect(form.get("visibility")).toBe("private");
  expect(form.get("expires_in")).toBe("7d");
});

test("a large put goes up in parts, retries a failed part and refreshes an expired part URL", async () => {
  let failures = 0;
  let expired = 0;
  let partUrlCalls = 0;
  let completes = 0;
  const api = fakeApi(async (call) => {
    if (call.url.endsWith("/v1/uploads") && call.method === "POST") {
      return Response.json({ id: "up_1", status: "active", transport: "s3", part_size: 4, total_parts: 3, uploaded_parts: [] }, { status: 201 });
    }
    if (call.url.includes("/part-urls")) {
      partUrlCalls += 1;
      return Response.json({ parts: [1, 2, 3].map((n) => ({ part_number: n, url: `https://storage.test/p${n}?v=${partUrlCalls}` })) });
    }
    if (call.url.startsWith("https://storage.test/p2") && failures === 0) {
      failures += 1;
      return new Response("busy", { status: 503 });
    }
    if (call.url.startsWith("https://storage.test/p3?v=1") && expired === 0) {
      expired += 1;
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }
    if (call.url.startsWith("https://storage.test/")) return new Response(null, { status: 200 });
    if (call.url.endsWith("/v1/uploads/up_1/complete")) {
      completes += 1;
      return completes === 1 ? Response.json({ id: "up_1" }, { status: 202 }) : Response.json(file("f_big", { size_bytes: 10 }));
    }
    return new Response("unexpected", { status: 500 });
  });
  const progress: number[] = [];
  const agentfs = createAgentFS({ apiKey: "afs_key", fetch: api.fetch, multipartThreshold: 1, retry: noWait });
  const stored = await agentfs.put("reports/big.bin", "0123456789", { onProgress: (done) => progress.push(done) });
  expect(stored.id).toBe("f_big");
  expect(failures).toBe(1);
  expect(expired).toBe(1);
  expect(partUrlCalls).toBe(2);
  expect(progress.at(-1)).toBe(10);
  const createBody = api.calls.find((call) => call.url.endsWith("/v1/uploads"))?.body;
  expect(JSON.parse(String(createBody))).toMatchObject({ path: "reports/big.bin", size_bytes: 10, multipart: true });
});

test("a refused upload surfaces the API error and cancels the session", async () => {
  const api = fakeApi((call) => {
    if (call.url.endsWith("/v1/uploads") && call.method === "POST") {
      return Response.json({ id: "up_2", status: "active", transport: "worker", part_size: 10, total_parts: 1, uploaded_parts: [] }, { status: 201 });
    }
    if (call.url.includes("/parts/1")) return Response.json({ code: "invalid_part", detail: "Part 1 must be exactly 10 bytes.", retryable: false }, { status: 400 });
    return new Response(null, { status: 204 });
  });
  const agentfs = createAgentFS({ apiKey: "afs_key", fetch: api.fetch, multipartThreshold: 1, retry: noWait });
  const failure = await agentfs.put("reports/x.bin", "0123456789").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AgentFSError);
  expect(failure).toMatchObject({ status: 400, code: "invalid_part", retryable: false });
  expect(api.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/uploads/up_2"))).toBe(true);
});

test("a file without a folder goes to the key's default project in a session upload", async () => {
  const api = fakeApi((call) => {
    if (call.url.endsWith("/v1/me")) return Response.json({ authenticated: true, default_project: "inbox" });
    if (call.url.endsWith("/v1/uploads")) return Response.json({ id: "up_3", status: "active", transport: "s3", part_size: 10, total_parts: 1, upload_url: "https://storage.test/whole", uploaded_parts: [] }, { status: 201 });
    if (call.url.startsWith("https://storage.test/")) return new Response(null, { status: 200 });
    return Response.json(file("f_whole"));
  });
  const agentfs = createAgentFS({ apiKey: "afs_key", fetch: api.fetch, multipartThreshold: 1, retry: noWait });
  await agentfs.put("notes.txt", "0123456789", { multipart: false });
  const createBody = api.calls.find((call) => call.url.endsWith("/v1/uploads"))?.body;
  expect(JSON.parse(String(createBody))).toMatchObject({ path: "inbox/notes.txt" });
  expect(api.calls.some((call) => call.url === "https://storage.test/whole" && call.method === "PUT")).toBe(true);
});

test("list maps runId to run_id and returns the next cursor", async () => {
  const api = fakeApi(() => Response.json({ items: [file("f_1")], next_cursor: "c2" }));
  const agentfs = createAgentFS({ apiKey: "afs_key", fetch: api.fetch });
  const page = await agentfs.list({ runId: "run_9", project: "reports", limit: 5 });
  expect(page).toMatchObject({ items: [{ id: "f_1" }], nextCursor: "c2" });
  const url = new URL(api.calls[0]?.url ?? "");
  expect(Object.fromEntries(url.searchParams)).toEqual({ project: "reports", run_id: "run_9", limit: "5" });
});

test("revokeAccess returns the new access version", async () => {
  const api = fakeApi(() => Response.json({ id: "f_1", access_version: 3 }));
  const agentfs = createAgentFS({ apiKey: "afs_key", fetch: api.fetch });
  expect(await agentfs.revokeAccess("f_1")).toEqual({ accessVersion: 3 });
});

test("replace over 100 MB is refused before any request", async () => {
  const api = fakeApi(() => new Response(null, { status: 500 }));
  const agentfs = createAgentFS({ apiKey: "afs_key", fetch: api.fetch });
  const big = new Uint8Array(100 * 1024 * 1024 + 1);
  await expect(agentfs.put("reports/big.bin", big, { replace: true })).rejects.toMatchObject({ code: "file_too_large" });
  expect(api.calls).toHaveLength(0);
});
