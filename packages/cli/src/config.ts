import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const DEFAULT_API_URL = "https://agentfs.cloud";

const storedSchema = z.object({
  apiKey: z.string().optional(),
  apiUrl: z.string().optional(),
});

export type Stored = z.infer<typeof storedSchema>;

export type Credentials = {
  apiKey: string | undefined;
  apiUrl: string;
  source: "flag" | "env" | "config" | "none";
};

export const configPath = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentfs", "config.json");

export function readConfig(): Stored {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(readFileSync(configPath(), "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeConfig(next: Stored) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export function clearConfig() {
  const stored = readConfig();
  rmSync(configPath(), { force: true });
  return stored.apiKey !== undefined;
}

export function resolveCredentials(flags: { apiKey?: string; apiUrl?: string }): Credentials {
  const stored = readConfig();
  const apiUrl = (flags.apiUrl || process.env.AGENTFS_API_URL || stored.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  if (flags.apiKey) return { apiKey: flags.apiKey, apiUrl, source: "flag" };
  if (process.env.AGENTFS_KEY) return { apiKey: process.env.AGENTFS_KEY, apiUrl, source: "env" };
  if (stored.apiKey) return { apiKey: stored.apiKey, apiUrl, source: "config" };
  return { apiKey: undefined, apiUrl, source: "none" };
}

export const maskKey = (key: string) => (key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "afs_…");
