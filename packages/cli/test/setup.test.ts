import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySkill, bundledSkill, editServers, writeEnvKey } from "../src/setup";

const temp = () => mkdtempSync(join(tmpdir(), "agentfs-"));

test("the bundled skill installs once, then reports it is already set, then removes cleanly", () => {
  const root = temp();
  expect(bundledSkill("agentfs")).toContain("name: agentfs");
  expect(applySkill(root, "agentfs", false)).toBe("added");
  expect(applySkill(root, "agentfs", false)).toBe("already set");
  expect(applySkill(root, "agentfs", true)).toBe("removed");
  expect(applySkill(root, "agentfs", true)).toBe("not set");
});

test("adding the MCP server keeps the other servers and settings", () => {
  const before = JSON.stringify({ theme: "dark", mcpServers: { other: { url: "https://x" } } });
  const change = editServers(before, "mcpServers", { url: "https://agentfs.cloud/mcp" });
  expect(change?.outcome).toBe("added");
  expect(JSON.parse(change?.text ?? "{}")).toEqual({
    theme: "dark",
    mcpServers: { other: { url: "https://x" }, agentfs: { url: "https://agentfs.cloud/mcp" } },
  });
  expect(editServers("not json", "mcpServers", {})).toBeUndefined();
});

test("env only replaces an existing key when asked", () => {
  const file = join(temp(), ".env");
  writeFileSync(file, "OTHER=1\nAGENTFS_KEY=afs_old\n");

  expect(writeEnvKey(file, { AGENTFS_KEY: "afs_new" }, false).AGENTFS_KEY).toStartWith("skipped");
  expect(readFileSync(file, "utf8")).toBe("OTHER=1\nAGENTFS_KEY=afs_old\n");

  expect(writeEnvKey(file, { AGENTFS_KEY: "afs_new" }, true).AGENTFS_KEY).toBe("updated");
  expect(readFileSync(file, "utf8")).toBe("OTHER=1\nAGENTFS_KEY=afs_new\n");

  const fresh = join(temp(), ".env");
  writeEnvKey(fresh, { AGENTFS_KEY: "afs_new" }, false);
  expect(readFileSync(fresh, "utf8")).toBe("AGENTFS_KEY=afs_new\n");
});
