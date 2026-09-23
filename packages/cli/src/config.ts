import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_API_URL = "https://agentfs.cloud";

const credentialsSchema = z.object({
  apiKey: z.string().optional(),
  apiUrl: z.string().optional(),
});

export type Stored = z.infer<typeof credentialsSchema>;

export type Credentials = {
  apiKey: string | undefined;
  apiUrl: string;
  source: "flag" | "env" | "config" | "none";
};

export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentfs");
export const credentialsPath = () => join(configDir(), "credentials.json");
const legacyPath = () => join(configDir(), "config.json");

const parse = (path: string): Stored | undefined => {
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export function writeConfig(next: Stored) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = credentialsPath();
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function readConfig(): Stored {
  const current = parse(credentialsPath());
  if (current) return current;
  const legacy = parse(legacyPath());
  if (!legacy) return {};
  writeConfig(legacy);
  rmSync(legacyPath(), { force: true });
  return legacy;
}

export function clearConfig() {
  const had = readConfig().apiKey !== undefined;
  rmSync(credentialsPath(), { force: true });
  rmSync(legacyPath(), { force: true });
  return had;
}

export function permissions(path: string) {
  if (!existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o777;
  return { mode: `0${mode.toString(8)}`, private: (mode & 0o077) === 0 };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function insecureApiUrl(apiUrl: string) {
  try {
    const url = new URL(apiUrl);
    if (url.protocol === "https:") return undefined;
    if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return undefined;
    return `The API URL ${apiUrl} is not HTTPS. AgentFS only sends your key over HTTPS, or HTTP to localhost.`;
  } catch {
    return `The API URL ${apiUrl} is not a valid URL.`;
  }
}

export function resolveCredentials(flags: { apiKey?: string }): Credentials {
  const stored = readConfig();
  const apiUrl = (process.env.AGENTFS_API_URL || stored.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  if (flags.apiKey) return { apiKey: flags.apiKey, apiUrl, source: "flag" };
  if (process.env.AGENTFS_KEY) return { apiKey: process.env.AGENTFS_KEY, apiUrl, source: "env" };
  if (stored.apiKey) return { apiKey: stored.apiKey, apiUrl, source: "config" };
  return { apiKey: undefined, apiUrl, source: "none" };
}

export const maskKey = (key: string) => {
  const prefix = key.startsWith("afs_") ? "afs_" : "";
  return key.length > prefix.length + 8 ? `${prefix}…${key.slice(-4)}` : `${prefix}…`;
};
