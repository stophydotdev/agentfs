export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;
export const DEFAULT_FILE_MODE = S_IFREG | 0o644;
export const DEFAULT_DIR_MODE = S_IFDIR | 0o755;

export type StatsData = {
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
};

export interface Stats extends StatsData {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export type DirEntry = { name: string; stats: Stats };
export type FilesystemStats = { inodes: number; bytesUsed: number };

export const createStats = (data: StatsData): Stats => ({
  ...data,
  isFile: () => (data.mode & S_IFMT) === S_IFREG,
  isDirectory: () => (data.mode & S_IFMT) === S_IFDIR,
  isSymbolicLink: () => (data.mode & S_IFMT) === S_IFLNK,
});

const inodeOf = (path: string) => {
  let hash = 0x811c9dc5;
  for (const char of path) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  return hash;
};

export const fileStats = (file: { path: string; size: number; updatedAt: string }) => {
  const seconds = Math.floor(Date.parse(file.updatedAt) / 1000);
  return createStats({
    ino: inodeOf(file.path),
    mode: DEFAULT_FILE_MODE,
    nlink: 1,
    uid: 0,
    gid: 0,
    size: file.size,
    atime: seconds,
    mtime: seconds,
    ctime: seconds,
  });
};

export const directoryStats = (path: string) =>
  createStats({
    ino: inodeOf(`${path}/`),
    mode: DEFAULT_DIR_MODE,
    nlink: 2,
    uid: 0,
    gid: 0,
    size: 0,
    atime: 0,
    mtime: 0,
    ctime: 0,
  });
