export const CHUNK_SIZE = 4096;
export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

export const SCHEMA = [
  `CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parameters TEXT,
  result TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
)`,
  "CREATE INDEX idx_tool_calls_name ON tool_calls(name)",
  "CREATE INDEX idx_tool_calls_started_at ON tool_calls(started_at)",
  `CREATE TABLE fs_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE fs_inode (
  ino INTEGER PRIMARY KEY AUTOINCREMENT,
  mode INTEGER NOT NULL,
  nlink INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  gid INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  atime INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  ctime INTEGER NOT NULL,
  rdev INTEGER NOT NULL DEFAULT 0,
  atime_nsec INTEGER NOT NULL DEFAULT 0,
  mtime_nsec INTEGER NOT NULL DEFAULT 0,
  ctime_nsec INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE fs_dentry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_ino INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  UNIQUE(parent_ino, name)
)`,
  "CREATE INDEX idx_fs_dentry_parent ON fs_dentry(parent_ino, name)",
  `CREATE TABLE fs_data (
  ino INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (ino, chunk_index)
)`,
  `CREATE TABLE fs_symlink (
  ino INTEGER PRIMARY KEY,
  target TEXT NOT NULL
)`,
  `CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
)`,
  "CREATE INDEX idx_kv_store_created_at ON kv_store(created_at)",
];
