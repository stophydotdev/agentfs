import { decode, encode, owned, sha256Hex, toBuffer } from "./bytes.js";
import type { Client } from "./client.js";
import { AgentFSError, type FsSyscall, fsError } from "./errors.js";
import { lastSegment, normalize } from "./paths.js";
import {
  type DirEntry,
  type FilesystemStats,
  type Stats,
  directoryStats,
  fileStats,
} from "./stats.js";
import type { FileInfo } from "./wire.js";

/** A write above this many bytes goes up in parts. The server refuses a direct upload at or below it, and it is the same on every plan. */
const PARTS_ABOVE_BYTES = 90 * 1024 * 1024;

type Encoding = BufferEncoding | { encoding?: BufferEncoding };
type WriteOptions = BufferEncoding | { encoding?: BufferEncoding; private?: boolean };
type Found =
  | { kind: "file"; file: FileInfo }
  | { kind: "directory" }
  | { kind: "missing"; requestId: string | null };

export type FileHandle = {
  pread(offset: number, size: number): Promise<Buffer>;
  pwrite(offset: number, data: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  fsync(): Promise<void>;
  fstat(): Promise<Stats>;
};

const encodingOf = (options: WriteOptions | undefined) =>
  typeof options === "string" ? options : options?.encoding;

const privateOf = (options: WriteOptions | undefined) =>
  typeof options === "string" ? undefined : options?.private;

export class Filesystem {
  private readonly made = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly prefix: string,
  ) {}

  private remote(path: string) {
    return this.prefix + normalize(path).join("/");
  }

  private folder(path: string) {
    const parts = normalize(path);
    return parts.length === 0 ? this.prefix : `${this.prefix}${parts.join("/")}/`;
  }

  private key(path: string) {
    return normalize(path).join("/");
  }

  private isMade(path: string) {
    const key = this.key(path);
    return [...this.made].some((made) => made === key || made.startsWith(`${key}/`));
  }

  private async children(path: string) {
    const page = await this.client.page(this.folder(path), "/", "");
    return page.files.length + page.folders.length > 0;
  }

  private async lookup(path: string): Promise<Found> {
    if (normalize(path).length === 0) return { kind: "directory" };
    const headed = await this.client.head(this.remote(path));
    if (headed.kind === "file") return headed;
    if (this.isMade(path) || (await this.children(path))) return { kind: "directory" };
    return headed;
  }

  private async wrapped<T>(syscall: FsSyscall, path: string, work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      throw error instanceof AgentFSError && error.syscall === undefined
        ? error.with({ syscall, path })
        : error;
    }
  }

  private async existing(path: string, syscall: FsSyscall) {
    const found = await this.lookup(path);
    if (found.kind === "missing") throw fsError("ENOENT", syscall, path, found.requestId);
    return found;
  }

  private async regular(path: string, syscall: FsSyscall) {
    const found = await this.existing(path, syscall);
    if (found.kind === "directory") throw fsError("EISDIR", syscall, path);
    return found.file;
  }

  async stat(path: string): Promise<Stats> {
    return this.wrapped("stat", path, async () => {
      const found = await this.existing(path, "stat");
      return found.kind === "file" ? fileStats(found.file) : directoryStats(this.key(path));
    });
  }

  lstat(path: string) {
    return this.stat(path);
  }

  private bytesOf(file: FileInfo, range?: { start: number; end: number }) {
    return file.url === null
      ? this.client.contentAt(file.path, range)
      : this.client.bytesAt(file.url, range);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return this.wrapped("open", path, async () =>
      this.bytesOf(await this.regular(path, "open")),
    );
  }

  readFile(path: string): Promise<Buffer>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>;
  readFile(path: string, options?: Encoding): Promise<Buffer | string>;
  async readFile(path: string, options?: Encoding): Promise<Buffer | string> {
    const bytes = await this.readBytes(path);
    const encoding = encodingOf(options);
    return encoding === undefined ? toBuffer(bytes) : decode(bytes, encoding);
  }

  async writeFile(path: string, data: string | Uint8Array, options?: WriteOptions) {
    await this.wrapped("open", path, async () => {
      const body = typeof data === "string" ? encode(data, encodingOf(options) ?? "utf8") : owned(data);
      const sha256 = await sha256Hex(body);
      const target = this.remote(path);
      const direct = body.byteLength > PARTS_ABOVE_BYTES;
      const visibility = { private: privateOf(options) };
      if (direct) await this.client.uploadDirect(target, body, sha256, visibility);
      else await this.client.put(target, body, sha256, visibility);
    });
  }

  private async entries(path: string) {
    const prefix = this.folder(path);
    const listing = await this.client.list(prefix, "/");
    const key = this.key(path);
    const stem = key === "" ? "" : `${key}/`;
    const made = [...this.made]
      .filter((entry) => entry !== key && entry.startsWith(stem))
      .map((entry) => entry.slice(stem.length).split("/")[0] ?? "");
    const folders = new Set([...listing.folders.map(lastSegment), ...made]);
    const files = listing.files.map((file) => ({ name: file.path.slice(prefix.length), file }));
    return { files, folders: [...folders] };
  }

  async readdir(path: string): Promise<string[]> {
    return this.wrapped("scandir", path, async () => {
      const { files, folders } = await this.entries(path);
      if (files.length + folders.length === 0) {
        const found = await this.existing(path, "scandir");
        if (found.kind === "file") throw fsError("ENOTDIR", "scandir", path);
      }
      return [...files.map((entry) => entry.name), ...folders].sort();
    });
  }

  async readdirPlus(path: string): Promise<DirEntry[]> {
    return this.wrapped("scandir", path, async () => {
      const { files, folders } = await this.entries(path);
      if (files.length + folders.length === 0) {
        const found = await this.existing(path, "scandir");
        if (found.kind === "file") throw fsError("ENOTDIR", "scandir", path);
      }
      const folderPath = this.key(path);
      return [
        ...files.map(({ name, file }) => ({ name, stats: fileStats(file) })),
        ...folders.map((name) => ({
          name,
          stats: directoryStats(folderPath === "" ? name : `${folderPath}/${name}`),
        })),
      ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }

  async mkdir(path: string) {
    const key = this.key(path);
    if (key !== "") this.made.add(key);
  }

  async rmdir(path: string) {
    await this.wrapped("rmdir", path, async () => {
      if (normalize(path).length === 0) throw fsError("EPERM", "rmdir", path);
      const found = await this.existing(path, "rmdir");
      if (found.kind === "file") throw fsError("ENOTDIR", "rmdir", path);
      if (await this.children(path)) throw fsError("ENOTEMPTY", "rmdir", path);
      this.made.delete(this.key(path));
    });
  }

  async unlink(path: string) {
    await this.wrapped("unlink", path, async () => {
      await this.regular(path, "unlink");
      await this.client.remove(this.remote(path));
    });
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }) {
    await this.wrapped("rm", path, async () => {
      if (normalize(path).length === 0) throw fsError("EPERM", "rm", path);
      const found = await this.lookup(path);
      if (found.kind === "missing") {
        if (options?.force === true) return;
        throw fsError("ENOENT", "rm", path, found.requestId);
      }
      if (found.kind === "file") return this.client.remove(this.remote(path));
      if (options?.recursive !== true) throw fsError("EISDIR", "rm", path);
      const key = this.key(path);
      for (const made of [...this.made]) if (made === key || made.startsWith(`${key}/`)) this.made.delete(made);
      if (await this.children(path)) await this.client.removeFolder(this.folder(path));
    });
  }

  async rename(oldPath: string, newPath: string) {
    await this.wrapped("rename", oldPath, async () => {
      if (normalize(oldPath).length === 0) throw fsError("EPERM", "rename", oldPath);
      const found = await this.existing(oldPath, "rename");
      if (found.kind === "file") return this.client.move(this.remote(oldPath), this.remote(newPath));
      if (await this.children(oldPath)) await this.client.move(this.folder(oldPath), this.folder(newPath));
      const from = this.key(oldPath);
      for (const made of [...this.made]) {
        if (made !== from && !made.startsWith(`${from}/`)) continue;
        this.made.delete(made);
        this.made.add(this.key(newPath) + made.slice(from.length));
      }
    });
  }

  async copyFile(src: string, dest: string) {
    await this.wrapped("copyfile", src, async () => {
      const file = await this.regular(src, "copyfile");
      const status = await this.client.link([
        { path: this.remote(dest), sha256: file.sha256, size: file.size, private: file.private || undefined },
      ]);
      if (status === "linked" || status === "unchanged") return;
      await this.writeFile(dest, await this.readBytes(src), { private: file.private || undefined });
    });
  }

  async symlink(_target: string, linkpath: string): Promise<void> {
    throw fsError("ENOSYS", "open", linkpath);
  }

  async readlink(path: string): Promise<string> {
    throw fsError("ENOSYS", "open", path);
  }

  async access(path: string) {
    await this.wrapped("access", path, async () => {
      await this.existing(path, "access");
    });
  }

  async exists(path: string) {
    return (await this.lookup(path)).kind !== "missing";
  }

  async statfs(): Promise<FilesystemStats> {
    const limits = await this.client.limits();
    return { inodes: limits.files, bytesUsed: limits.usedBytes };
  }

  /** The public link of a file. A private file has none: use `signedUrl`. */
  async link(path: string) {
    return this.wrapped("open", path, async () => {
      const { url } = await this.regular(path, "open");
      if (url === null) {
        throw new AgentFSError({
          code: "EPERM",
          message: `EPERM: this file is private and has no public link, use signedUrl, open '${path}'`,
          syscall: "open",
          path,
        });
      }
      return url;
    });
  }

  /** A link that opens a file with no key until it expires: 300 seconds by default, at most 3600. It stops working when the file is changed or deleted. */
  async signedUrl(path: string, options: { ttlSeconds?: number } = {}) {
    return this.wrapped("open", path, async () => {
      const file = await this.regular(path, "open");
      return this.client.sign(file.path, options.ttlSeconds);
    });
  }

  async open(path: string): Promise<FileHandle> {
    const file = await this.wrapped("open", path, () => this.regular(path, "open"));
    const rewrite = async (change: (current: Uint8Array) => Uint8Array) => {
      await this.writeFile(path, change(await this.readBytes(path)));
    };
    return {
      pread: async (offset, size) => {
        const bytes =
          offset >= file.size || size <= 0
            ? new Uint8Array(0)
            : await this.bytesOf(file, { start: offset, end: offset + size - 1 });
        return toBuffer(bytes);
      },
      pwrite: (offset, data) =>
        rewrite((current) => {
          const next = new Uint8Array(Math.max(current.byteLength, offset + data.byteLength));
          next.set(current);
          next.set(data, offset);
          return next;
        }),
      truncate: (size) =>
        rewrite((current) => {
          const next = new Uint8Array(size);
          next.set(current.subarray(0, size));
          return next;
        }),
      fsync: async () => {},
      fstat: () => this.stat(path),
    };
  }
}

