import { mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Api, ApiError, type Json } from "./api";
import { CHUNK_SIZE, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from "./fsdb";
import { put } from "./put";
import { type Sqlite, openDatabase } from "./sqlite";

const BATCH_CHUNKS = 256;
const REFUSED = new Set(["invalid_kv", "value_too_large", "invalid_event"]);

const names = z.array(z.object({ name: z.string() }));
const config = z.array(z.object({ value: z.string() }));
const inodes = z.array(z.object({ ino: z.number(), mode: z.number() }));
const dentries = z.array(z.object({ name: z.string(), parent_ino: z.number(), ino: z.number() }));
const chunks = z.array(z.object({ chunk_index: z.number(), data: z.instanceof(Uint8Array) }));
const kvRows = z.array(z.object({ key: z.string(), value: z.string() }));
const toolRows = z.array(
  z.object({
    name: z.string(),
    parameters: z.string().nullable(),
    result: z.string().nullable(),
    error: z.string().nullable(),
    started_at: z.number(),
    duration_ms: z.number(),
  }),
);

export type ImportOptions = { to: string; includeSecrets: boolean; force: boolean };

export type ImportSummary = {
  files: number;
  bytes: number;
  kv: number;
  toolCalls: number;
  skipped: string[];
  problems: string[];
};

const parseJson = (text: string): Json => {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return text;
  }
};

const isSafeName = (name: string) => name !== "" && name !== "." && name !== ".." && !/[/\0]/u.test(name);

const regularFiles = (db: Sqlite) => {
  const modes = new Map(inodes.parse(db.all("SELECT ino, mode FROM fs_inode")).map((row) => [row.ino, row.mode]));
  const children = new Map<number, { name: string; ino: number }[]>();
  for (const row of dentries.parse(db.all("SELECT name, parent_ino, ino FROM fs_dentry"))) {
    children.set(row.parent_ino, [...(children.get(row.parent_ino) ?? []), { name: row.name, ino: row.ino }]);
  }
  const files: { path: string; ino: number }[] = [];
  const skipped: string[] = [];
  const seen = new Set([1]);
  const visit = (directory: number, prefix: string) => {
    for (const { name, ino } of children.get(directory) ?? []) {
      const path = `${prefix}${name}`;
      const kind = (modes.get(ino) ?? 0) & S_IFMT;
      if (!isSafeName(name)) skipped.push(`${path} (unsafe name)`);
      else if (kind === S_IFREG) files.push({ path, ino });
      else if (kind === S_IFLNK) skipped.push(`${path} (symlink)`);
      else if (kind !== S_IFDIR) skipped.push(`${path} (not a regular file)`);
      else if (seen.has(ino)) skipped.push(`${path} (directory loop)`);
      else {
        seen.add(ino);
        visit(ino, `${path}/`);
      }
    }
  };
  visit(1, "");
  return { files, skipped };
};

const extract = async (db: Sqlite, ino: number, target: string, chunkSize: number) => {
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(target, "w");
  try {
    let next = 0;
    for (;;) {
      const rows = chunks.parse(
        db.all(
          `SELECT chunk_index, data FROM fs_data WHERE ino = ? AND chunk_index >= ? ORDER BY chunk_index LIMIT ${BATCH_CHUNKS}`,
          ino,
          next,
        ),
      );
      const last = rows[rows.length - 1];
      if (last === undefined) return;
      for (const row of rows) await handle.write(row.data, 0, row.data.length, row.chunk_index * chunkSize);
      next = last.chunk_index + 1;
    }
  } finally {
    await handle.close();
  }
};

const describe = (what: string, error: unknown) =>
  `${what}: ${error instanceof Error ? error.message : String(error)}`;

const record = (summary: ImportSummary, what: string, error: unknown) => {
  if (error instanceof ApiError && REFUSED.has(error.code)) summary.skipped.push(describe(what, error));
  else summary.problems.push(describe(what, error));
};

export const importDatabase = async (
  api: Api,
  file: string,
  { to, includeSecrets, force }: ImportOptions,
): Promise<ImportSummary> => {
  if (!(await stat(file).catch(() => null))?.isFile()) throw new Error(`no such file: ${file}`);
  const db = await openDatabase(file, "read");
  const summary: ImportSummary = { files: 0, bytes: 0, kv: 0, toolCalls: 0, skipped: [], problems: [] };
  const temporary = await mkdtemp(join(tmpdir(), "agentfs-import-"));
  try {
    const tables = new Set(names.parse(db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name));
    for (const table of ["fs_inode", "fs_dentry", "fs_data"]) {
      if (!tables.has(table)) throw new Error(`${file} is not an AgentFS database: no ${table} table`);
    }
    const chunkSize = tables.has("fs_config")
      ? Number(config.parse(db.all("SELECT value FROM fs_config WHERE key = 'chunk_size'"))[0]?.value ?? CHUNK_SIZE)
      : CHUNK_SIZE;
    const { files, skipped } = regularFiles(db);
    summary.skipped.push(...skipped);
    for (const entry of files) await extract(db, entry.ino, join(temporary, ...entry.path.split("/")), chunkSize);
    const { outcomes, skipped: secrets } = await put(
      api,
      (await readdir(temporary)).map((name) => join(temporary, name)),
      { to, includeSecrets, force, ttlSeconds: undefined },
    );
    summary.skipped.push(...secrets.map((path) => `${path} (looks like a secret; add --include-secrets)`));
    for (const outcome of outcomes) {
      if (outcome.kind === "failed") summary.problems.push(`${outcome.path}: ${outcome.reason}`);
      else if (outcome.kind === "conflict") summary.problems.push(`${outcome.path}: changed remotely while uploading, not uploaded`);
      else {
        summary.files += 1;
        summary.bytes += outcome.file.size;
      }
    }
    const kv = tables.has("kv_store") ? kvRows.parse(db.all("SELECT key, value FROM kv_store ORDER BY key")) : [];
    for (const row of kv) {
      await api
        .kvSet(row.key, parseJson(row.value), { precondition: { kind: "none" }, ttlSeconds: undefined })
        .then(() => {
          summary.kv += 1;
        })
        .catch((error: unknown) => record(summary, `kv ${row.key}`, error));
    }
    const calls = tables.has("tool_calls")
      ? toolRows.parse(db.all("SELECT name, parameters, result, error, started_at, duration_ms FROM tool_calls ORDER BY started_at, id"))
      : [];
    for (const call of calls) {
      await api
        .logEvent({
          name: call.name,
          ...(call.parameters === null ? {} : { input: parseJson(call.parameters) }),
          ...(call.error !== null
            ? { output: call.error }
            : call.result === null
              ? {}
              : { output: parseJson(call.result) }),
          status: call.error === null ? "ok" : "error",
          durationMs: call.duration_ms,
          startedAt: new Date(call.started_at * 1000).toISOString(),
        })
        .then(() => {
          summary.toolCalls += 1;
        })
        .catch((error: unknown) => record(summary, `tool call ${call.name}`, error));
    }
    return summary;
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
};
