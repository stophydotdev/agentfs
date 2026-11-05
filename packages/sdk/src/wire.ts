import { malformed } from "./errors.js";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Fields = { [key: string]: unknown };

export type FileInfo = {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  updatedAt: string;
  url: string | null;
  private: boolean;
};
export type SignedLink = { url: string; expiresAt: string };
export type Listing = { files: FileInfo[]; folders: string[]; cursor: string | null };
export type Started = { upload: string; uploadId: string; partBytes: number };
export type Snapshot = { name: string; prefix: string; files: number; bytes: number; createdAt: string };
export type Restored = { name: string; to: string; restored: number; deleted: number };
export type Diff = {
  from: string;
  to: string | null;
  added: { path: string; sha256: string; size: number }[];
  changed: { path: string; fromSha256: string; toSha256: string; size: number }[];
  removed: { path: string; sha256: string }[];
};
export type KvItem = {
  key: string;
  version: number;
  updatedAt: string;
  expiresAt: string | null;
};
export type ToolEvent = {
  id: string;
  at: string;
  name: string;
  input: Json | null;
  output: Json | null;
  status: "ok" | "error";
  durationMs: number;
};
export type Problem = {
  code: string;
  message: string;
  retryAfter: number | null;
  requestId: string | null;
};

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isJson = (value: unknown): value is Json => {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value) ? value.every(isJson) : Object.values(value).every(isJson);
    default:
      return false;
  }
};

export const toJson = (value: unknown): Json | undefined => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  const parsed: unknown = JSON.parse(encoded);
  return isJson(parsed) ? parsed : undefined;
};

export const fields = (value: unknown, what: string): Fields =>
  isFields(value) ? value : malformed(what);

const text = (from: Fields, key: string): string => {
  const value = from[key];
  return typeof value === "string" ? value : malformed(key);
};

const count = (from: Fields, key: string): number => {
  const value = from[key];
  return typeof value === "number" ? value : malformed(key);
};

const maybeText = (from: Fields, key: string): string | null => {
  const value = from[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : malformed(key);
};

const maybeJson = (from: Fields, key: string): Json | null => {
  const value = from[key];
  if (value === undefined) return null;
  return isJson(value) ? value : malformed(key);
};

const list = <T>(from: Fields, key: string, read: (item: unknown) => T): T[] => {
  const value = from[key];
  return Array.isArray(value) ? value.map(read) : malformed(key);
};

export const readFile = (value: unknown): FileInfo => {
  const file = fields(value, "file");
  return {
    path: text(file, "path"),
    size: count(file, "size"),
    sha256: text(file, "sha256"),
    contentType: text(file, "contentType"),
    updatedAt: text(file, "updatedAt"),
    url: maybeText(file, "url"),
    private: file.private === true,
  };
};

export const readSignedLink = (value: unknown): SignedLink => {
  const link = fields(value, "signed link");
  return { url: text(link, "url"), expiresAt: text(link, "expiresAt") };
};

export const readListing = (value: unknown): Listing => {
  const page = fields(value, "listing");
  return {
    files: list(page, "files", readFile),
    folders: list(page, "folders", (folder) =>
      typeof folder === "string" ? folder : malformed("folders"),
    ),
    cursor: maybeText(page, "cursor"),
  };
};

export const readLimits = (value: unknown) => {
  const limits = fields(value, "limits");
  return {
    maxFileBytes: count(limits, "maxFileBytes"),
    usedBytes: count(limits, "usedBytes"),
    files: count(limits, "files"),
  };
};

export const readStarted = (value: unknown): Started => {
  const started = fields(value, "upload");
  return {
    upload: text(started, "upload"),
    uploadId: text(started, "uploadId"),
    partBytes: count(started, "partBytes"),
  };
};

export const readPart = (value: unknown) => {
  const part = fields(value, "part");
  return { partNumber: count(part, "partNumber"), etag: text(part, "etag") };
};

export const readSnapshot = (value: unknown): Snapshot => {
  const snapshot = fields(value, "snapshot");
  return {
    name: text(snapshot, "name"),
    prefix: text(snapshot, "prefix"),
    files: count(snapshot, "files"),
    bytes: count(snapshot, "bytes"),
    createdAt: text(snapshot, "createdAt"),
  };
};

export const readRestored = (value: unknown): Restored => {
  const restored = fields(value, "restore");
  return {
    name: text(restored, "name"),
    to: text(restored, "to"),
    restored: count(restored, "restored"),
    deleted: count(restored, "deleted"),
  };
};

export const readDiff = (value: unknown): Diff => {
  const diff = fields(value, "diff");
  return {
    from: text(diff, "from"),
    to: maybeText(diff, "to"),
    added: list(diff, "added", (entry) => {
      const added = fields(entry, "added");
      return { path: text(added, "path"), sha256: text(added, "sha256"), size: count(added, "size") };
    }),
    changed: list(diff, "changed", (entry) => {
      const changed = fields(entry, "changed");
      return {
        path: text(changed, "path"),
        fromSha256: text(changed, "fromSha256"),
        toSha256: text(changed, "toSha256"),
        size: count(changed, "size"),
      };
    }),
    removed: list(diff, "removed", (entry) => {
      const removed = fields(entry, "removed");
      return { path: text(removed, "path"), sha256: text(removed, "sha256") };
    }),
  };
};

export const readKvItem = (value: unknown): KvItem => {
  const item = fields(value, "kv item");
  if (!("value" in item)) return malformed("kv item");
  return {
    key: text(item, "key"),
    version: count(item, "version"),
    updatedAt: text(item, "updatedAt"),
    expiresAt: maybeText(item, "expiresAt"),
  };
};

export const readKvPage = (value: unknown) => {
  const page = fields(value, "kv page");
  return { items: list(page, "items", readKvItem), cursor: maybeText(page, "cursor") };
};

export const readToolEvent = (value: unknown): ToolEvent => {
  const event = fields(value, "event");
  const id = text(event, "id");
  const status = text(event, "status");
  if (!/^\d+$/u.test(id) || (status !== "ok" && status !== "error")) return malformed("event");
  return {
    id,
    at: text(event, "at"),
    name: text(event, "name"),
    input: maybeJson(event, "input"),
    output: maybeJson(event, "output"),
    status,
    durationMs: count(event, "durationMs"),
  };
};

export const readEvents = (value: unknown) => {
  const page = fields(value, "events");
  return { events: list(page, "events", readToolEvent), cursor: maybeText(page, "cursor") };
};

export const readLinkStatus = (value: unknown) => {
  const [first] = list(fields(value, "link answer"), "files", (entry) => fields(entry, "file"));
  return first === undefined ? malformed("link answer") : text(first, "status");
};

export const readKey = (value: unknown) => text(fields(value, "signup"), "key");

export const readProblem = (value: unknown): Problem | null => {
  if (!isFields(value) || !isFields(value.error)) return null;
  const { error } = value;
  if (typeof error.code !== "string" || typeof error.message !== "string") return null;
  return {
    code: error.code,
    message: error.message,
    retryAfter: typeof error.retryAfter === "number" ? error.retryAfter : null,
    requestId: typeof error.requestId === "string" ? error.requestId : null,
  };
};
