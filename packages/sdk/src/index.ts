export { AgentFS, type AgentFSOptions } from "./agentfs.js";
export { AgentFSError, type FsErrorCode, type FsSyscall } from "./errors.js";
export { Filesystem, type FileHandle } from "./fs.js";
export { KvStore } from "./kv.js";
export { ToolCalls, type ToolCall } from "./tools.js";
export {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  createStats,
  type DirEntry,
  type FilesystemStats,
  type Stats,
  type StatsData,
} from "./stats.js";
export type { Diff, Restored, SignedLink, Snapshot } from "./wire.js";
