import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError, createClient } from "../src/api";
import { uploadFile, withRetry } from "../src/upload";
import { fakeApi } from "./fake-api";

let stop = () => {};
afterEach(() => stop());

const localFile = (name: string, content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "agentfs-")), name);
  writeFileSync(path, content);
  return path;
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

test("a large file uses a session, sends every part in order and completes", async () => {
  const api = fakeApi({ partSize: 4 });
  stop = api.stop;
  const client = createClient({ apiKey: "afs_test", apiUrl: api.url });

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, 0);

  const created = api.seen.find((entry) => entry.path === "/v1/uploads");
  expect(JSON.parse(created?.body ?? "{}")).toMatchObject({ path: "default/big.txt", size_bytes: 10 });
  expect([...api.parts.entries()]).toEqual([[1, "0123"], [2, "4567"], [3, "89"]]);
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

test("a part that fails with a 5xx is retried and the upload still completes", async () => {
  const api = fakeApi({ partSize: 4, failPartOnce: 2 });
  stop = api.stop;
  const client = createClient({ apiKey: "afs_test", apiUrl: api.url });

  await uploadFile(client, localFile("big.txt", "0123456789"), {}, undefined, 0);

  expect(api.seen.filter((entry) => entry.path === "/v1/uploads/up_1/parts/2")).toHaveLength(2);
  expect([...api.parts.entries()]).toEqual([[1, "0123"], [2, "4567"], [3, "89"]]);
});

test("client errors are not retried", async () => {
  let calls = 0;
  const task = async () => {
    calls += 1;
    throw new ApiError(403, "forbidden", "no", undefined);
  };
  await expect(withRetry(task, 3, async () => {})).rejects.toThrow("no");
  expect(calls).toBe(1);
});
