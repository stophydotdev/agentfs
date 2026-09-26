import { openAsBlob, statSync } from "node:fs";
import { basename } from "node:path";

import type { Visibility } from "../../sdk/src/client";
import type { RetryPolicy } from "../../sdk/src/retry";
import { fileSchema, type Client, type StoredFile } from "./api";

const MIB = 1024 * 1024;
export const ONE_SHOT_LIMIT = 100 * MIB;
export const KEYLESS_TOO_LARGE = "Log in to upload files over 100 MB: agentfs login";
const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];

export type Transfer = {
  sessionThreshold: number;
  keylessLimit: number;
  concurrency: number;
  retry: Partial<RetryPolicy>;
};

export const defaultTransfer = (): Transfer => ({
  sessionThreshold: 16 * MIB,
  keylessLimit: ONE_SHOT_LIMIT,
  concurrency: 6,
  retry: { attempts: 8, baseDelayMs: 500, maxDelayMs: 15_000 },
});

export type UploadOptions = {
  project?: string;
  path?: string;
  prefix?: string;
  visibility?: string;
  expiresIn?: string;
  label?: string;
  replace?: boolean;
  runId?: string;
  agentId?: string;
};

export const joinPath = (...parts: (string | undefined)[]) =>
  parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");

const isVisibility = (value: string): value is Visibility => VISIBILITIES.some((visibility) => visibility === value);

function visibilityOf(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!isVisibility(value)) throw new Error(`--visibility must be ${VISIBILITIES.join(", ")}.`);
  return value;
}

function runHeaders(options: UploadOptions): Record<string, string> {
  return {
    ...(options.runId ? { "x-run-id": options.runId } : {}),
    ...(options.agentId ? { "x-agent-id": options.agentId } : {}),
  };
}

export async function projectOf(client: Client, project: string | undefined) {
  return project ?? (await client.me()).default_project ?? "default";
}

async function uploadKeyless(client: Client, local: string) {
  const form = new FormData();
  form.append("file", await openAsBlob(local), basename(local));
  return client.uploadForm(form, {});
}

async function targetPath(client: Client, local: string, options: UploadOptions) {
  const project = await projectOf(client, options.project);
  return options.path ? joinPath(project, options.path) : joinPath(project, options.prefix, basename(local));
}

export async function uploadFile(
  client: Client,
  local: string,
  options: UploadOptions,
  onProgress?: (done: number) => void,
  overrides: Partial<Transfer> = {},
): Promise<StoredFile> {
  const transfer = { ...defaultTransfer(), ...overrides };
  const stats = statSync(local);
  if (!stats.isFile()) throw new Error(`${local} is not a file.`);
  if (!client.hasKey) {
    if (stats.size > transfer.keylessLimit) throw new Error(KEYLESS_TOO_LARGE);
    return uploadKeyless(client, local);
  }
  const visibility = visibilityOf(options.visibility);
  const [blob, path] = await Promise.all([openAsBlob(local), targetPath(client, local, options)]);
  const sdk = client.transfer(runHeaders(options), { concurrency: transfer.concurrency, retry: transfer.retry });
  const write = {
    ...(visibility ? { visibility } : {}),
    ...(options.expiresIn ? { expiresIn: options.expiresIn } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(onProgress ? { onProgress: (done: number) => onProgress(done) } : {}),
  };
  const stored = await sdk.store(path, blob, { ...write, multipart: stats.size > transfer.sessionThreshold, ifExists: options.replace ? "replace" : "error" });
  return fileSchema.parse(stored);
}
