import { UsageError } from "./usage-error";

const UNITS = new Map([
  ["B", 1],
  ["KB", 1e3],
  ["MB", 1e6],
  ["GB", 1e9],
  ["TB", 1e12],
]);

export const parseBytes = (text: string) => {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?B)?$/iu.exec(text.trim());
  const factor = UNITS.get((match?.[2] ?? "B").toUpperCase());
  if (match?.[1] === undefined || factor === undefined) {
    throw new UsageError(`use a size like 500MB or 5GB, not "${text}"`);
  }
  return Math.round(Number(match[1]) * factor);
};

export const formatBytes = (bytes: number) => {
  const [unit, factor] = [...UNITS].findLast(([, size]) => bytes >= size) ?? ["B", 1];
  return `${Number((bytes / factor).toFixed(1))} ${unit}`;
};

const SECONDS = new Map([
  ["s", 1],
  ["m", 60],
  ["h", 3600],
  ["d", 86400],
]);

export const parseDuration = (text: string) => {
  const match = /^(\d+)([smhd])$/u.exec(text.trim());
  const factor = SECONDS.get(match?.[2] ?? "");
  if (match?.[1] === undefined || factor === undefined) {
    throw new UsageError(`use a duration like 30m, 1h or 7d, not "${text}"`);
  }
  return Number(match[1]) * factor;
};
