import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError, createClient } from "../src/api";
import { KEYLESS_TOO_LARGE, uploadFile, withRetry, type Transfer } from "../src/upload";
import { fakeApi, type FakeOptions } from "./fake-api";

let stop = () => {};
afterEach(() => stop());

const localFile = (name: string, content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "agentfs-")), name);
  writeFileSync(path, content);
  return path;
};

const session = (options: FakeOptions) => {
  const api = fakeApi(options);
  stop = api.stop;
  const client = createClient({ apiKey: "afs_test", apiUrl: api.url });
  const sleeps: number[] = [];
  const transfer: Partial<Transfer> = {
    sessionThreshold: 0,
    stateDir: mkdtempSync(join(tmpdir(), "agentfs-state-")),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
  };
  const count = (path: string) => api.seen.filter((entry) => entry.method === "PUT" && entry.path.startsWith(path)).length;
  return { api, client, sleeps, transfer, count };
};

test("a small file goes up in one request with its fields and run headers", async () => {
  const api = fakeApi();
  stop = api.stop;
  const client = createClient({ apiKey: "afs_test", apiUrl: api.url });

  const file = await uploadFile(client, localFile("notes.md", "hello"), { project: "research", prefix: "runs", visibility: "private", runId: "run_7" });

  const request = api.seen.find((entry) => entry.path === "/v1/files");
  expect(request?.form).toMatchObject({ file: "file:notes.md", path: "research/runs/notes.md", visibility: "private" });
  expect(request?.form).not.toHaveProperty("prefix");
  expect(request?.headers.get("x-run-id")).toBe("run_7");
  expect(file.url).toBe("https://f.agentfs.cloud/f/f_1");
});

test("a large file uses a multipart session, sends every part and completes", async () => {
  const { api, client, transfer } = session({ partSize: 4 });
  const progress: number[] = [];

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, (done) => progress.push(done), transfer);

  const created = api.seen.find((entry) => entry.path === "/v1/uploads");
  expect(JSON.parse(created?.body ?? "{}")).toMatchObject({ path: "default/big.txt", size_bytes: 10, multipart: true });
  expect(new Map(api.parts)).toEqual(new Map([[1, "0123"], [2, "4567"], [3, "89"]]));
  expect(api.seen.at(-1)?.path).toBe("/v1/uploads/up_1/complete");
  expect(progress.at(-1)).toBe(10);
  expect(readdirSync(transfer.stateDir ?? "")).toEqual([]);
});

test("direct parts upload six at a time with URLs fetched in one batch", async () => {
  const { api, client, transfer } = session({ transport: "s3", partSize: 1, partDelayMs: 40 });

  await uploadFile(client, localFile("big.txt", "abcdefghijkl"), {}, undefined, transfer);

  expect(api.load.maxInFlight).toBe(6);
  expect(api.parts.size).toBe(12);
  expect(api.seen.filter((entry) => entry.path.startsWith("/v1/uploads/up_1/part-urls")).map((entry) => entry.path)).toEqual([
    "/v1/uploads/up_1/part-urls?from=1&to=12",
  ]);
});

test("a part that fails with 503 is retried with jittered backoff and the upload completes", async () => {
  const { api, client, sleeps, transfer, count } = session({ partSize: 4, failures: { 2: [{ status: 503 }, { status: 503 }] } });

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, transfer);

  expect(count("/v1/uploads/up_1/parts/2")).toBe(3);
  expect(sleeps).toEqual([500, 1000]);
  expect(new Map(api.parts)).toEqual(new Map([[1, "0123"], [2, "4567"], [3, "89"]]));
});

test("Retry-After on a 429 sets the wait before the next attempt", async () => {
  const { client, sleeps, transfer, count } = session({ partSize: 4, failures: { 1: [{ status: 429, retryAfter: "7" }] } });

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, transfer);

  expect(count("/v1/uploads/up_1/parts/1")).toBe(2);
  expect(sleeps).toEqual([7000]);
});

test("an expired part URL is fetched again and the part retried", async () => {
  const { api, client, sleeps, transfer, count } = session({ transport: "s3", partSize: 4, expireFirstUrl: [2] });

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, transfer);

  expect(count("/storage/2")).toBe(2);
  expect(api.seen.filter((entry) => entry.path.startsWith("/v1/uploads/up_1/part-urls"))).toHaveLength(2);
  expect(sleeps).toEqual([]);
});

test("a client error on a part fails fast with the server's message and aborts the session", async () => {
  const { api, client, transfer, count } = session({ partSize: 4, failures: { 1: [{ status: 400 }] } });

  await expect(uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, transfer)).rejects.toThrow("Part 1 failed.");

  expect(count("/v1/uploads/up_1/parts/1")).toBe(1);
  expect(api.seen.some((entry) => entry.method === "DELETE" && entry.path === "/v1/uploads/up_1")).toBe(true);
});

test("a second run resumes the session and skips parts already uploaded", async () => {
  const { api, client, transfer, count } = session({ partSize: 4, failures: { 3: Array.from({ length: 8 }, () => ({ status: 503 })) } });
  const local = localFile("big.txt", "0123456789");

  await expect(uploadFile(client, local, {}, undefined, transfer)).rejects.toThrow("Part 3 failed.");
  expect(readdirSync(transfer.stateDir ?? "")).toHaveLength(1);
  const before = api.seen.length;

  await uploadFile(client, local, {}, undefined, transfer);

  const second = api.seen.slice(before).map((entry) => `${entry.method} ${entry.path}`);
  expect(second).toEqual(["GET /v1/me", "GET /v1/uploads/up_1", "PUT /v1/uploads/up_1/parts/3", "POST /v1/uploads/up_1/complete"]);
  expect(count("/v1/uploads/up_1/parts/1")).toBe(1);
  expect(existsSync(join(transfer.stateDir ?? "", readdirSync(transfer.stateDir ?? "")[0] ?? "none"))).toBe(false);
});

test("an older server that returns upload_url gets the whole file in one PUT", async () => {
  const { api, client, transfer, count } = session({ transport: "single" });

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, transfer);

  expect(count("/storage/1")).toBe(1);
  expect(new Map(api.parts)).toEqual(new Map([[1, "0123456789"]]));
  expect(api.seen.some((entry) => entry.path.startsWith("/v1/uploads/up_1/part-urls"))).toBe(false);
  expect(api.seen.at(-1)?.path).toBe("/v1/uploads/up_1/complete");
});

test("a file keeps its own name when no path is given", async () => {
  const api = fakeApi();
  stop = api.stop;
  const client = createClient({ apiKey: "afs_test", apiUrl: api.url });

  await uploadFile(client, localFile("sales.csv", "a,b"), {});

  expect(api.seen.find((entry) => entry.path === "/v1/files")?.form?.path).toBe("default/sales.csv");
});

test("--path is inside the default project when no project is given", async () => {
  const api = fakeApi();
  stop = api.stop;
  const client = createClient({ apiKey: "afs_test", apiUrl: api.url });

  await uploadFile(client, localFile("second.md", "hi"), { path: "cli-test/second.md" });

  expect(api.seen.find((entry) => entry.path === "/v1/files")?.form?.path).toBe("default/cli-test/second.md");
});

test("client errors are not retried", async () => {
  let calls = 0;
  const task = async () => {
    calls += 1;
    throw new ApiError(403, "forbidden", "no", undefined);
  };
  await expect(withRetry(task, { sleep: async () => {}, random: () => 1 })).rejects.toThrow("no");
  expect(calls).toBe(1);
});

test("without a key, a small file goes up alone with no path and no auth header", async () => {
  const api = fakeApi();
  stop = api.stop;
  const client = createClient({ apiKey: undefined, apiUrl: api.url });

  const file = await uploadFile(client, localFile("report.pdf", "hello"), { runId: "run_7" });

  expect(api.seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["POST /v1/files"]);
  expect(api.seen[0]?.form).toEqual({ file: "file:report.pdf" });
  expect(api.seen[0]?.headers.has("authorization")).toBe(false);
  expect(file.expires_at).toBe("2026-09-24T00:00:00.000Z");
});

test("without a key, a file over the one-shot limit asks for a login and sends nothing", async () => {
  const api = fakeApi();
  stop = api.stop;
  const client = createClient({ apiKey: undefined, apiUrl: api.url });

  await expect(uploadFile(client, localFile("big.bin", "0123456789"), {}, undefined, { keylessLimit: 4 })).rejects.toThrow(KEYLESS_TOO_LARGE);
  expect(api.seen).toEqual([]);
});
