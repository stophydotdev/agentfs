export type FsErrorCode =
  | "ENOENT"
  | "EEXIST"
  | "EISDIR"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "EPERM"
  | "EINVAL"
  | "ENOSYS";

export type FsSyscall =
  | "open"
  | "stat"
  | "mkdir"
  | "rmdir"
  | "rm"
  | "unlink"
  | "rename"
  | "scandir"
  | "copyfile"
  | "access";

type Failure = {
  code: string;
  message: string;
  agentfsCode?: string | null;
  requestId?: string | null;
  status?: number | null;
  retryAfter?: number | null;
  syscall?: FsSyscall;
  path?: string;
};

const ERRNO = new Map<string, FsErrorCode>([
  ["not_found", "ENOENT"],
  ["file_exists", "EEXIST"],
  ["invalid_path", "EINVAL"],
  ["invalid_move", "EINVAL"],
  ["key_scope", "EPERM"],
]);

const REASON: Record<FsErrorCode, string> = {
  ENOENT: "no such file or directory",
  EEXIST: "file already exists",
  EISDIR: "illegal operation on a directory",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  EPERM: "operation not permitted",
  EINVAL: "invalid argument",
  ENOSYS: "function not implemented",
};

export class AgentFSError extends Error {
  readonly code: string;
  readonly agentfsCode: string | null;
  readonly requestId: string | null;
  readonly status: number | null;
  readonly retryAfter: number | null;
  readonly syscall: FsSyscall | undefined;
  readonly path: string | undefined;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = "AgentFSError";
    this.code = failure.code;
    this.agentfsCode = failure.agentfsCode ?? null;
    this.requestId = failure.requestId ?? null;
    this.status = failure.status ?? null;
    this.retryAfter = failure.retryAfter ?? null;
    this.syscall = failure.syscall;
    this.path = failure.path;
  }

  with(context: { syscall: FsSyscall; path: string }) {
    return new AgentFSError({ ...this, message: this.message, ...context });
  }
}

export const fromProblem = (
  problem: { code: string; message: string; retryAfter: number | null; requestId: string | null },
  status: number,
  requestId: string | null,
) =>
  new AgentFSError({
    code: ERRNO.get(problem.code) ?? problem.code,
    message: `${problem.code}: ${problem.message}`,
    agentfsCode: problem.code,
    requestId: requestId ?? problem.requestId,
    status,
    retryAfter: problem.retryAfter,
  });

export const fsError = (
  code: FsErrorCode,
  syscall: FsSyscall,
  path: string,
  requestId: string | null = null,
) =>
  new AgentFSError({
    code,
    message: `${code}: ${REASON[code]}, ${syscall} '${path}'`,
    agentfsCode: code === "ENOENT" ? "not_found" : null,
    requestId,
    syscall,
    path,
  });

export const malformed = (what: string): never => {
  throw new AgentFSError({
    code: "bad_response",
    message: `bad_response: the server sent an unexpected ${what}.`,
  });
};
