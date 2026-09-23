import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli";
import { credentialsPath, maskKey, readConfig, resolveCredentials, writeConfig } from "../src/config";
import { fakeApi } from "./fake-api";

let output: string[] = [];
const env = { ...process.env };

beforeEach(() => {
  output = [];
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agentfs-"));
  delete process.env.AGENTFS_KEY;
  delete process.env.AGENTFS_API_URL;
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  process.env = { ...env };
});

test("the key comes from the flag, then the environment, then the saved config", () => {
  writeConfig({ apiKey: "afs_saved" });
  expect(resolveCredentials({})).toMatchObject({ apiKey: "afs_saved", source: "config" });
  process.env.AGENTFS_KEY = "afs_env";
  expect(resolveCredentials({})).toMatchObject({ apiKey: "afs_env", source: "env" });
  expect(resolveCredentials({ apiKey: "afs_flag" })).toMatchObject({ apiKey: "afs_flag", source: "flag" });
});

test("commands that need a key fail with a JSON error an agent can read", async () => {
  expect(await main(["ls", "--json"])).toBe(1);
  expect(JSON.parse(output.join(""))).toEqual({ success: false, error: { code: "usage", message: "Not logged in. Run agentfs login, or set AGENTFS_KEY." } });
});

test("upload works before login and says the link expires", async () => {
  const api = fakeApi();
  process.env.AGENTFS_API_URL = api.url;
  const stderr: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const local = join(mkdtempSync(join(tmpdir(), "agentfs-")), "report.pdf");
  writeFileSync(local, "hello");

  const code = await main(["upload", local, "--json"]);
  api.stop();

  expect(code).toBe(0);
  expect(JSON.parse(output.join(""))).toMatchObject({ path: "/guest/report.pdf", expires_at: "2026-09-24T00:00:00.000Z" });
  expect(stderr.join("")).toContain("links expire in 24 hours. Run agentfs login to keep files.");
});

test("upload options that need an account ask for a login before login", async () => {
  const local = join(mkdtempSync(join(tmpdir(), "agentfs-")), "report.pdf");
  writeFileSync(local, "hello");
  expect(await main(["upload", local, "--path", "docs/report.pdf", "--json"])).toBe(1);
  expect(JSON.parse(output.join(""))).toEqual({ success: false, error: { code: "usage", message: "Log in to use --path: agentfs login" } });
});

test("credentials are written to a file only you can read, even over a loose one", () => {
  writeConfig({ apiKey: "afs_one" });
  chmodSync(credentialsPath(), 0o644);
  writeConfig({ apiKey: "afs_two" });

  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  expect(statSync(join(credentialsPath(), "..")).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({ apiKey: "afs_two" });
});

test("a key saved by an older version moves into credentials.json", () => {
  const legacy = join(credentialsPath(), "..", "config.json");
  writeConfig({});
  writeFileSync(legacy, JSON.stringify({ apiKey: "afs_legacy" }));
  writeFileSync(credentialsPath(), "not json");

  expect(readConfig()).toEqual({ apiKey: "afs_legacy" });
  expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({ apiKey: "afs_legacy" });
});

test("keys are masked to their last four characters", () => {
  expect(maskKey("afs_00000000000000000000000000001234")).toBe("afs_…1234");
  expect(maskKey("afs_short")).toBe("afs_…");
});

test("a batch upload keeps going past a failed file and reports both", async () => {
  const api = fakeApi({ takenPaths: ["default/taken.md"] });
  process.env.AGENTFS_API_URL = api.url;
  const dir = mkdtempSync(join(tmpdir(), "agentfs-"));
  writeFileSync(join(dir, "taken.md"), "a");
  writeFileSync(join(dir, "fresh.md"), "b");

  const code = await main(["upload", join(dir, "taken.md"), join(dir, "fresh.md"), "--json", "--api-key", "afs_test"]);
  api.stop();

  expect(code).toBe(1);
  const result = JSON.parse(output.join(""));
  expect(result.success).toBe(false);
  expect(result.files).toHaveLength(1);
  expect(result.failed).toEqual([{ file: join(dir, "taken.md"), error: { code: "path_exists", message: "The path /default/taken.md already exists." } }]);
});

test("the key is never sent over plain HTTP to another host", async () => {
  process.env.AGENTFS_API_URL = "http://files.example.com";
  expect(await main(["status", "--json", "--api-key", "afs_test"])).toBe(1);
  expect(JSON.parse(output.join("")).error.message).toContain("not HTTPS");
});

test("download refuses to overwrite a file and never writes outside the folder", async () => {
  const api = fakeApi();
  process.env.AGENTFS_API_URL = api.url;
  const dir = mkdtempSync(join(tmpdir(), "agentfs-"));
  const cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "taken.txt"), "mine");
  try {
    expect(await main(["download", "f_1", "-o", "taken.txt", "--json", "--api-key", "afs_test"])).toBe(1);
    expect(readFileSync(join(dir, "taken.txt"), "utf8")).toBe("mine");
  } finally {
    process.chdir(cwd);
    api.stop();
  }
});
