import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli";
import { resolveCredentials, writeConfig } from "../src/config";

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
