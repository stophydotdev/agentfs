import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "../src/api";
import { KEYLESS_TOO_LARGE, uploadFile, type Transfer } from "../src/upload";
import { fakeApi, type FakeOptions } from "./fake-api";

let stop = () => {};
afterEach(() => stop());

const localFile = (name: string, content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "agentfs-")), name);
  writeFileSync(path, content);
  return path;
};

const keyed = (options: FakeOptions = {}) => {
  const api = fakeApi(options);
  stop = api.stop;
  return { api, client: createClient({ apiKey: "afs_test", apiUrl: api.url }) };
};

const session = (options: FakeOptions) => {
  const { api, client } = keyed(options);
  const sleeps: number[] = [];
  const transfer: Partial<Transfer> = {
    sessionThreshold: 0,
    retry: { attempts: 8, baseDelayMs: 500, maxDelayMs: 15_000, sleep: async (ms: number) => void sleeps.push(ms), random: () => 1 },
  };
  return { api, client, sleeps, transfer };
};

test("a small file goes up in one PUT with its fields and run headers", async () => {
  const { api, client } = keyed();

  const file = await uploadFile(client, localFile("notes.md", "hello"), { project: "research", prefix: "runs", visibility: "private", label: "draft", runId: "run_7" });

  expect(api.seen.map((entry) => entry.method)).toEqual(["PUT"]);
  const request = api.seen[0];
  const url = new URL(request?.path ?? "", api.url);
  expect(url.pathname).toBe("/v1/files/research/runs/notes.md");
  expect(Object.fromEntries(url.searchParams)).toEqual({ visibility: "private", label: "draft" });
  expect(request?.body).toBe("hello");
  expect(request?.headers.get("if-none-match")).toBe("*");
  expect(request?.headers.get("x-run-id")).toBe("run_7");
  expect(request?.headers.get("user-agent")).toStartWith("agentfs-cli/");
  expect(file).toMatchObject({ id: "f_1", url: "https://f.agentfs.cloud/f/f_1", markdown: "[x](https://f.agentfs.cloud/f/f_1)" });
});

test("--replace overwrites instead of failing on an existing path", async () => {
  const { api, client } = keyed({ takenPaths: ["default/notes.md"] });

  await expect(uploadFile(client, localFile("notes.md", "a"), {})).rejects.toThrow("The path /default/notes.md already exists.");
  await uploadFile(client, localFile("notes.md", "b"), { replace: true });

  expect(api.seen.filter((entry) => entry.method === "PUT").map((entry) => entry.headers.get("if-none-match"))).toEqual(["*", null]);
});

test("a large file uses a multipart session, sends every part and completes", async () => {
  const { api, client, transfer } = session({ partSize: 4 });
  const progress: number[] = [];

  await uploadFile(client, localFile("big.txt", "0123456789"), { visibility: "public" }, (done) => progress.push(done), transfer);

  const created = api.seen.find((entry) => entry.path === "/v1/uploads");
  expect(JSON.parse(created?.body ?? "{}")).toMatchObject({ path: "default/big.txt", size_bytes: 10, multipart: true, if_exists: "error", visibility: "public" });
  expect(new Map(api.parts)).toEqual(new Map([[1, "0123"], [2, "4567"], [3, "89"]]));
  expect(api.seen.at(-1)?.path).toBe("/v1/uploads/up_1/complete");
  expect(progress.at(-1)).toBe(10);
});

test("a file over 1 MiB goes straight to storage without the key, then completes through the API", async () => {
  const { api, client } = keyed({ direct: true });
  const content = "x".repeat(1024 * 1024 + 1);

  await uploadFile(client, localFile("mid.bin", content), { replace: true });

  expect(api.seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /v1/me", "POST /v1/uploads", "PUT /storage/whole", "POST /v1/uploads/up_1/complete"]);
  expect(JSON.parse(api.seen[1]?.body ?? "{}")).toMatchObject({ size_bytes: content.length, multipart: false, if_exists: "replace" });
  expect(api.seen[2]?.headers.has("authorization")).toBe(false);
  expect(api.parts.get(1)).toBe(content);
});

test("a part that fails with 503 is retried with the CLI's backoff and the upload completes", async () => {
  const { api, client, sleeps, transfer } = session({ partSize: 4, failures: { 2: [{ status: 503 }, { status: 503 }] } });

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, transfer);

  expect(api.seen.filter((entry) => entry.path === "/v1/uploads/up_1/parts/2")).toHaveLength(3);
  expect(sleeps).toEqual([1000, 2000]);
  expect(new Map(api.parts)).toEqual(new Map([[1, "0123"], [2, "4567"], [3, "89"]]));
});

test("--path is inside the default project when no project is given", async () => {
  const { api, client } = keyed();

  await uploadFile(client, localFile("second.md", "hi"), { path: "cli-test/second.md" });

  expect(api.seen.map((entry) => `${entry.method} ${entry.path.split("?")[0]}`)).toEqual(["GET /v1/me", "PUT /v1/files/default/cli-test/second.md"]);
});

test("an unknown visibility fails before anything is sent", async () => {
  const { api, client } = keyed();

  await expect(uploadFile(client, localFile("a.md", "hi"), { project: "p", visibility: "secret" })).rejects.toThrow("--visibility must be public, unlisted, private.");
  expect(api.seen).toEqual([]);
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
