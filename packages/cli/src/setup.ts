import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SKILLS = ["agentfs"] as const;
export const SKILLS_REPO = "stophydotdev/agentfs";
const SERVER = "agentfs";

export type Outcome = "added" | "updated" | "already set" | "removed" | "not set" | `skipped: ${string}` | `failed: ${string}`;

export function bundledSkill(name: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = [join(here, "skills", name), join(here, "..", "..", "..", "skills", name)].find((path) => existsSync(join(path, "SKILL.md")));
  if (!dir) throw new Error(`The bundled ${name} skill is missing from this install.`);
  return dir;
}

export function skillRoots(scope: { global: boolean; cwd: string; home: string }) {
  const base = scope.global ? scope.home : scope.cwd;
  return [join(base, ".claude", "skills"), join(base, ".agents", "skills")];
}

function filesIn(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path), readFileSync(path, "utf8"));
  }
  return files;
}

const sameFiles = (a: Map<string, string>, b: Map<string, string>) =>
  a.size === b.size && [...a].every(([path, content]) => b.get(path) === content);

export function applySkill(root: string, name: string, remove: boolean, source = bundledSkill(name)): Outcome {
  const target = join(root, name);
  const installed = existsSync(join(target, "SKILL.md"));
  if (remove) {
    if (!installed) return "not set";
    rmSync(target, { recursive: true, force: true });
    return "removed";
  }
  if (installed && sameFiles(filesIn(source), filesIn(target))) return "already set";
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  return installed ? "updated" : "added";
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

type McpTarget = { name: string; location: string; found: () => boolean; present: () => boolean; apply: (remove: boolean) => Outcome };

function fileTarget(name: string, path: string, section: string, entry: Entry): McpTarget {
  return {
    name,
    location: path,
    found: () => existsSync(dirname(path)),
    present() {
      if (!existsSync(path)) return false;
      try {
        const config = jsonObject.safeParse(JSON.parse(readFileSync(path, "utf8")));
        const servers = config.success ? jsonObject.safeParse(config.data[section] ?? {}) : undefined;
        return servers?.success === true && servers.data[SERVER] !== undefined;
      } catch {
        return false;
      }
    },
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
    location: join(homedir(), ".claude.json"),
    found: () => onPath("claude"),
    present: () => onPath("claude") && run(["mcp", "get", SERVER]).status === 0,
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

export function mcpCopies(home = homedir()) {
  return mcpTargets("", "", home).filter((target) => target.present()).map(({ name, location }) => ({ name, location }));
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

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function installedTargets(output: string) {
  return [
    ...new Set(
      output
        .replace(ANSI, "")
        .split("\n")
        .map((line) => line.match(/→\s+(\S*skills\/[^\s│]+)/)?.[1])
        .filter((target): target is string => target !== undefined),
    ),
  ];
}

const npmFreeEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("npm_config_") && !name.startsWith("npm_lifecycle") && name !== "npm_command"));

export function skillsCli(options: { remove: boolean; local: boolean; cwd: string }) {
  const scope = options.local ? [] : ["-g"];
  const run = (args: string[]) => {
    const result = spawnSync("npx", ["-y", "skills", ...args, "-y", ...scope], {
      cwd: options.cwd,
      encoding: "utf8",
      env: npmFreeEnv(),
      timeout: 120_000,
      shell: process.platform === "win32",
    });
    return { ok: result.status === 0, targets: installedTargets(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
  };
  const results = SKILLS.map((skill) => {
    if (options.remove) return run(["remove", skill]);
    const fromRepo = run(["add", SKILLS_REPO, "--skill", skill, "--copy"]);
    return fromRepo.ok && fromRepo.targets.length > 0 ? fromRepo : run(["add", bundledSkill(skill), "--copy"]);
  });
  return { ok: results.every((result) => result.ok), targets: results.flatMap((result) => result.targets) };
}
