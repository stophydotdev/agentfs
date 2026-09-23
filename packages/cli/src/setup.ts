import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SKILLS = ["agentfs"] as const;
const SERVER = "agentfs";

export type Outcome = "added" | "updated" | "already set" | "removed" | "not set" | `skipped: ${string}` | `failed: ${string}`;

export function bundledSkill(name: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = [join(here, "skills", name, "SKILL.md"), join(here, "..", "..", "..", "skills", name, "SKILL.md")].find(existsSync);
  if (!path) throw new Error(`The bundled ${name} skill is missing from this install.`);
  return readFileSync(path, "utf8");
}

export function skillRoots(scope: { global: boolean; cwd: string; home: string }) {
  const base = scope.global ? scope.home : scope.cwd;
  return [join(base, ".claude", "skills"), join(base, ".agents", "skills")];
}

export function applySkill(root: string, name: string, remove: boolean, content = bundledSkill(name)): Outcome {
  const path = join(root, name, "SKILL.md");
  if (remove) {
    if (!existsSync(path)) return "not set";
    rmSync(dirname(path), { recursive: true, force: true });
    return "removed";
  }
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (before === content) return "already set";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return before === undefined ? "added" : "updated";
}

const jsonObject = z.record(z.string(), z.json());
type Entry = z.infer<typeof jsonObject>[string];

export function editServers(text: string, section: string, entry: Entry | undefined): { text: string; outcome: Outcome } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim() || "{}");
  } catch {
    return undefined;
  }
  const config = jsonObject.safeParse(raw);
  const servers = config.success ? jsonObject.safeParse(config.data[section] ?? {}) : undefined;
  if (!config.success || !servers?.success) return undefined;
  const current = servers.data[SERVER];
  const next = { ...servers.data };
  if (entry === undefined) {
    if (current === undefined) return { text, outcome: "not set" };
    delete next[SERVER];
  } else {
    if (JSON.stringify(current) === JSON.stringify(entry)) return { text, outcome: "already set" };
    next[SERVER] = entry;
  }
  const outcome: Outcome = entry === undefined ? "removed" : current === undefined ? "added" : "updated";
  return { text: `${JSON.stringify({ ...config.data, [section]: next }, null, 2)}\n`, outcome };
}

type McpTarget = { name: string; found: () => boolean; apply: (remove: boolean) => Outcome };

function fileTarget(name: string, path: string, section: string, entry: Entry): McpTarget {
  return {
    name,
    found: () => existsSync(dirname(path)),
    apply(remove) {
      const before = existsSync(path) ? readFileSync(path, "utf8") : "";
      const change = editServers(before, section, remove ? undefined : entry);
      if (!change) return `skipped: ${path} isn't plain JSON, add agentfs by hand`;
      if (change.text !== before) {
        const temp = `${path}.agentfs-${process.pid}`;
        writeFileSync(temp, change.text, { mode: 0o600 });
        renameSync(temp, path);
      }
      return change.outcome;
    },
  };
}

const onPath = (bin: string) => spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;

function claudeTarget(url: string, key: string): McpTarget {
  const run = (args: string[]) => spawnSync("claude", args, { encoding: "utf8" });
  return {
    name: "claude-code",
    found: () => onPath("claude"),
    apply(remove) {
      const present = run(["mcp", "get", SERVER]).status === 0;
      if (remove && !present) return "not set";
      if (present) run(["mcp", "remove", "-s", "user", SERVER]);
      if (remove) return "removed";
      const added = run(["mcp", "add", "--transport", "http", "-s", "user", SERVER, url, "--header", `Authorization: Bearer ${key}`]);
      if (added.status !== 0) return `failed: ${(added.stderr || added.stdout).trim().split("\n")[0] ?? "claude mcp add failed"}`;
      return present ? "updated" : "added";
    },
  };
}

export function mcpTargets(apiUrl: string, key: string, home = homedir()): McpTarget[] {
  const url = `${apiUrl}/mcp`;
  const headers = { Authorization: `Bearer ${key}` };
  return [
    claudeTarget(url, key),
    fileTarget("cursor", join(home, ".cursor", "mcp.json"), "mcpServers", { url, headers }),
    fileTarget("opencode", join(home, ".config", "opencode", "opencode.json"), "mcp", { type: "remote", url, headers, enabled: true }),
  ];
}

export function writeEnvKey(path: string, values: Record<string, string>, overwrite: boolean) {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = before.split("\n");
  const outcomes: Record<string, Outcome> = {};
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.replace(/^export\s+/, "").startsWith(`${name}=`));
    if (index === -1) {
      if (lines.length > 0 && lines.at(-1) === "") lines.pop();
      lines.push(`${name}=${value}`, "");
      outcomes[name] = "added";
    } else if (lines[index] === `${name}=${value}`) {
      outcomes[name] = "already set";
    } else if (overwrite) {
      lines[index] = `${name}=${value}`;
      outcomes[name] = "updated";
    } else {
      outcomes[name] = "skipped: already in the file, pass --overwrite to replace it";
    }
  }
  const text = lines.join("\n");
  if (text !== before) writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
  return outcomes;
}
