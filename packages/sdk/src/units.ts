import { BlobError } from "./errors";

export type Size = number | `${number}${"b" | "kb" | "mb" | "gb" | "tb"}`;
export type Duration = `${number}${"s" | "m" | "h" | "d" | "w"}`;
export type CacheOption = "immutable" | "revalidate" | "no-store" | Duration;

const BYTES = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 } as const;

const isUnit = (unit: string | undefined): unit is keyof typeof BYTES => unit !== undefined && unit in BYTES;

export const parseSize = (value: Size, name: string): number => {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)$/.exec(value);
  const unit = match?.[2];
  if (!match || !isUnit(unit)) throw new BlobError("invalid_input", { message: `${name}: "${value}" is not a size like 20mb` });
  return Math.round(Number(match[1]) * BYTES[unit]);
};

export const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${Number(value.toFixed(1))} ${units[index]}`;
};

export const typeMatches = (allowed: readonly string[], contentType: string): boolean => {
  const actual = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return allowed.some((pattern) => {
    const want = pattern.trim().toLowerCase();
    return want === "*/*" || want === actual || (want.endsWith("/*") && actual.startsWith(want.slice(0, -1)));
  });
};
