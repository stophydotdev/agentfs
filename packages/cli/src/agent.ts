import { execFileSync } from "node:child_process";

const KNOWN_AGENTS: [name: string, signals: string[]][] = [
  ["claude-code", ["CLAUDECODE"]],
  ["codex", ["CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID"]],
  ["cursor", ["CURSOR_AGENT"]],
  ["gemini-cli", ["GEMINI_CLI"]],
  ["opencode", ["OPENCODE_CLIENT", "OPENCODE"]],
];

const firstSet = (names: string[]) =>
  names.map((name) => process.env[name]).find((value) => value !== undefined && value !== "");

const gitCommit = () => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

export const attribution = () => {
  const values = {
    "x-agentfs-agent":
      firstSet(["AGENTFS_AGENT"]) ??
      KNOWN_AGENTS.find(([, signals]) => firstSet(signals) !== undefined)?.[0] ??
      firstSet(["AI_AGENT"]),
    "x-agentfs-session": firstSet(["AGENTFS_SESSION", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]),
    "x-agentfs-commit": gitCommit(),
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
};
