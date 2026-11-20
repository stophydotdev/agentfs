import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { z } from "zod";
import type { Api } from "./api";
import { CHUNK_SIZE, S_IFDIR, S_IFREG, SCHEMA } from "./fsdb";
import { folder } from "./folder";
import { inParallel } from "./local";
import { type Sqlite, openDatabase } from "./sqlite";

const FILE_MODE = S_IFREG | 0o644;
const DIRECTORY_MODE = S_IFDIR | 0o755;

const created = z.array(z.object({ ino: z.number() }));

const stamp = (iso: string) => {
  const milliseconds = Date.parse(iso);
  return { seconds: Math.floor(milliseconds / 1000), nanos: (milliseconds % 1000) * 1e6 };
};

const insertInode = (db: Sqlite, mode: number, size: number, iso: string) => {
  const { seconds, nanos } = stamp(iso);
  const rows = created.parse(
    db.all(
      `INSERT INTO fs_inode (mode, nlink, uid, gid, size, atime, mtime, ctime, atime_nsec, mtime_nsec, ctime_nsec)
       VALUES (?, 1, 0, 0, ?, ?, ?, ?, ?, ?, ?) RETURNING ino`,
      mode,
      size,
      seconds,
      seconds,
      seconds,
      nanos,
      nanos,
      nanos,
    ),
  );
  const ino = rows[0]?.ino;
  if (ino === undefined) throw new Error("the database did not return an inode number");
  return ino;
};

const build = async (api: Api, prefix: string, db: Sqlite) => {
  const [files, items] = await Promise.all([api.list(prefix), api.kvList(prefix)]);
  const now = new Date().toISOString();
  db.exec("BEGIN");
  for (const statement of SCHEMA) db.exec(statement);
  db.run("INSERT INTO fs_config (key, value) VALUES ('chunk_size', ?)", String(CHUNK_SIZE));
  db.run(
    "INSERT INTO fs_inode (ino, mode, nlink, uid, gid, size, atime, mtime, ctime) VALUES (1, ?, 1, 0, 0, 0, ?, ?, ?)",
    DIRECTORY_MODE,
    stamp(now).seconds,
    stamp(now).seconds,
    stamp(now).seconds,
  );
  const directories = new Map<string, number>();
  const ensureDirectory = (parts: string[]) => {
    let parent = 1;
    let key = "";
    for (const name of parts) {
      key = `${key}${name}/`;
      const known = directories.get(key);
      if (known !== undefined) {
        parent = known;
        continue;
      }
      const ino = insertInode(db, DIRECTORY_MODE, 0, now);
      db.run("INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)", name, parent, ino);
      directories.set(key, ino);
      parent = ino;
    }
    return parent;
  };
  const store = (path: string, updatedAt: string, bytes: Uint8Array) => {
    const parts = path.split("/").filter((part) => part !== "");
    const name = parts.pop() ?? "";
    const parent = ensureDirectory(parts);
    const ino = insertInode(db, FILE_MODE, bytes.length, updatedAt);
    db.run("INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)", name, parent, ino);
    for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_SIZE, index += 1) {
      db.run("INSERT INTO fs_data (ino, chunk_index, data) VALUES (?, ?, ?)", ino, index, bytes.slice(offset, offset + CHUNK_SIZE));
    }
  };
  const failures = (
    await inParallel(files, async (file) => {
      try {
        const response = file.url === null ? await api.content(file.path) : await fetch(file.url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
          throw new Error("the downloaded bytes do not match the file's sha256");
        }
        store(file.path.slice(prefix.length), file.updatedAt, bytes);
        return null;
      } catch (error) {
        return `${file.path}: ${error instanceof Error ? error.message : String(error)}`;
      }
    })
  ).filter((failure) => failure !== null);
  if (failures.length > 0) throw new Error(`could not export, ${failures.join("; ")}`);
  for (const item of items) {
    const { seconds } = stamp(item.updatedAt);
    db.run("INSERT INTO kv_store (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)", item.key, JSON.stringify(item.value), seconds, seconds);
  }
  db.exec("COMMIT");
  return { files: files.length, bytes: files.reduce((total, file) => total + file.size, 0), kv: items.length };
};

export const exportDatabase = async (api: Api, path: string, file: string) => {
  if (await stat(file).catch(() => null)) throw new Error(`${file} already exists`);
  const db = await openDatabase(file, "create");
  try {
    const summary = await build(api, folder(path), db);
    db.close();
    return summary;
  } catch (error) {
    db.close();
    await rm(file, { force: true });
    throw error;
  }
};
