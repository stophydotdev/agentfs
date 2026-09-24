import { expect, test } from "bun:test";

import { errorFromResponse } from "../src/errors";
import { checkMetadata } from "../src/metadata";
import { checkContentType, expandContentTypes } from "../src/sniff";
import { Bucket } from "../src/index";

const problem = (status: number, code: string, detail = "server detail") =>
  new Response(JSON.stringify({ code, title: code, status, detail }), { status, headers: { "content-type": "application/problem+json" } });

test("server errors take Upstash's code, default message and status", async () => {
  expect((await errorFromResponse(problem(412, "precondition_failed"), "x")).toJSON()).toEqual({ code: "conflict", message: "The object changed since it was read", status: 409 });
  expect((await errorFromResponse(problem(404, "file_not_found"), "x")).toJSON()).toEqual({ code: "not_found", message: "Not found", status: 404 });
  expect((await errorFromResponse(problem(503, "upload_unavailable"), "x")).code).toBe("not_ready");
  expect((await errorFromResponse(problem(500, "internal_error"), "x")).toJSON()).toMatchObject({ code: "request_failed", status: 502 });
  expect((await errorFromResponse(problem(400, "invalid_metadata", "bad key"), "x")).message).toBe("Bad key");
});

test("content type refusals are 400 with Upstash's hints", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  expect(() => checkContentType("text/html", undefined, ["image/png"])).toThrow(expect.objectContaining({ status: 400, hint: "allowed: image/png" }));
  expect(() => checkContentType("application/pdf", png, expandContentTypes(["application/pdf"]))).toThrow(
    expect.objectContaining({ status: 400, message: "The bytes are image/png, which cannot be served as application/pdf (declare the type the bytes actually are, or add it to contentTypes)" }),
  );
});

test("info() on a missing path says which path", async () => {
  const fetch = Object.assign(async () => problem(404, "file_not_found"), { preconnect: () => undefined });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch });
  await expect(bucket.info("nope.txt")).rejects.toMatchObject({ code: "not_found", message: "nope.txt not found" });
  await expect(bucket.get("nope.txt")).rejects.toMatchObject({ code: "not_found", message: "Not found" });
});

test("metadata is checked like Upstash before any request, and keys go lowercase", async () => {
  const sent: unknown[] = [];
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init).url);
    return problem(500, "internal_error");
  }, { preconnect: () => undefined });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch });
  await expect(bucket.put("a.txt", "x", { metadata: { "has space": "v" } })).rejects.toMatchObject({ code: "invalid_input", message: 'Metadata key "has space" is not a valid header name' });
  await expect(bucket.put("a.txt", "x", { metadata: { k: "é" } })).rejects.toMatchObject({ code: "invalid_input", hint: "metadata is printable ASCII; percent-encode anything else with encodeURIComponent" });
  await expect(bucket.copy("a.txt", "b.txt", { metadata: { k: "\n" } })).rejects.toMatchObject({ code: "invalid_input" });
  expect(sent).toEqual([]);
  expect(checkMetadata({ Owner: "u7" })).toEqual({ owner: "u7" });
});

test("paths are checked like Upstash and sent exactly as given", async () => {
  const urls: string[] = [];
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    urls.push(new URL(request.url).pathname);
    return request.url.endsWith("/v1/me") ? Response.json({ default_project: "site" }) : problem(404, "file_not_found");
  }, { preconnect: () => undefined });
  const bucket = new Bucket({ token: "afs_key", fetch });
  await expect(bucket.put("", "x")).rejects.toThrow(new TypeError("path must be a non-empty string"));
  await expect(bucket.put("a/./b.txt", "x")).rejects.toThrow(TypeError);
  await expect(bucket.info("../x.txt")).rejects.toThrow(TypeError);
  await bucket.exists("/lead//b.txt/");
  expect(urls.at(-1)).toBe("/v1/files/site//lead//b.txt/");
});

test("retries follow Upstash: 3 attempts for idempotent verbs, full jitter from 200ms, Retry-After capped at 10s, never a POST", async () => {
  const calls: string[] = [];
  const waits: number[] = [];
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response(JSON.stringify({ code: "busy", title: "busy", status: 503, detail: "busy" }), {
      status: 503,
      headers: { "content-type": "application/problem+json", ...(calls.length === 1 ? { "retry-after": "60" } : {}) },
    });
  }, { preconnect: () => undefined });
  const bucket = new Bucket({ token: "afs_key", bucket: "site", fetch, retry: { sleep: async (ms) => void waits.push(ms), random: () => 0.999999 } });
  await expect(bucket.info("a.txt")).rejects.toMatchObject({ code: "not_ready" });
  expect(calls).toHaveLength(3);
  expect(waits).toEqual([10_000, 799]);

  calls.length = 0;
  await expect(bucket.move("a.txt", "b.txt")).rejects.toMatchObject({ status: 503 });
  expect(calls).toEqual(["POST /v1/files/site/a.txt/move"]);
});
