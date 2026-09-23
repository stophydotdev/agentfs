import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySkill, bundledSkill, editServers, SKILLS } from "../src/setup";

const temp = () => mkdtempSync(join(tmpdir(), "agentfs-"));

test("every bundled skill installs, then reports already set, then removes cleanly", () => {
  const root = temp();
  for (const skill of SKILLS) expect(existsSync(join(bundledSkill(skill), "SKILL.md"))).toBe(true);

  expect(applySkill(root, "agentfs", false)).toBe("added");
  expect(existsSync(join(root, "agentfs", "SKILL.md"))).toBe(true);
  expect(applySkill(root, "agentfs", false)).toBe("already set");

  writeFileSync(join(root, "agentfs", "SKILL.md"), "stale");
  expect(applySkill(root, "agentfs", false)).toBe("updated");

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

test("control characters from the server are stripped before printing", async () => {
  const { clean } = await import("../src/ui");
  expect(clean("report\u001b]52;c;ZXZpbA==\u0007.pdf")).toBe("report]52;c;ZXZpbA==.pdf");
});

test("the skills installer's output is read into the folders it wrote to", async () => {
  const { installedTargets } = await import("../src/setup");
  const output = "\u001b[32m◇  Installed 1 skill\u001b[39m\n│  ✓ agentfs (copied)              │\n│    → ~/.claude/skills/agentfs    │\n│    → ~/.agents/skills/agentfs    │\n│    → ~/.pi/agent/skills/agentfs  │\n";
  expect(installedTargets(output)).toEqual(["~/.claude/skills/agentfs", "~/.agents/skills/agentfs", "~/.pi/agent/skills/agentfs"]);
});
