const PREFIX = "agentfs-blob:v1:";

export interface PendingRecord {
  completionToken: string;
}

export const fingerprint = (route: string, file: File): string => `${PREFIX}${route}|${file.name}|${file.size}|${file.lastModified}`;

const storage = (): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

const isPending = (value: unknown): value is PendingRecord =>
  typeof value === "object" && value !== null && "completionToken" in value && typeof value.completionToken === "string";

export const readPending = (key: string): PendingRecord | undefined => {
  try {
    const raw = storage()?.getItem(key);
    const record: unknown = raw ? JSON.parse(raw) : undefined;
    return isPending(record) ? { completionToken: record.completionToken } : undefined;
  } catch {
    return undefined;
  }
};

export const writePending = (key: string, record: PendingRecord): void => {
  try {
    storage()?.setItem(key, JSON.stringify(record));
  } catch {
    return;
  }
};

export const clearPending = (key: string): void => {
  try {
    storage()?.removeItem(key);
  } catch {
    return;
  }
};
