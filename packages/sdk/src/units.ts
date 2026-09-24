export type Size = string | number;
export type Duration = string | number;
export type CacheOption = Duration | "immutable" | "revalidate" | "no-store";

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };

export const parseSize = (input: Size, what = "size"): number => {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new TypeError(`${what}: expected a non-negative number of bytes, got ${input}`);
    return Math.floor(input);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(input);
  if (!match) throw new TypeError(`${what}: cannot parse "${input}" (try '2mb', '500kb', '5gb')`);
  const multiplier = SIZE_UNITS[(match[2] || "b").toLowerCase()];
  if (multiplier === undefined) throw new TypeError(`${what}: unknown unit "${match[2]}" in "${input}" (b, kb, mb, gb, tb)`);
  return Math.floor(Number(match[1]) * multiplier);
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes)) return `${bytes} B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 999.95 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

export const parseDuration = (input: Duration, what = "duration"): number => {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new TypeError(`${what}: expected a non-negative number of seconds, got ${input}`);
    return Math.floor(input * 1000);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(input);
  if (!match) throw new TypeError(`${what}: cannot parse "${input}" (try '15m', '2h', '7d')`);
  const multiplier = DURATION_UNITS[(match[2] || "s").toLowerCase()];
  if (multiplier === undefined) throw new TypeError(`${what}: unknown unit "${match[2]}" in "${input}" (s, m, h, d)`);
  return Math.floor(Number(match[1]) * multiplier);
};

export const wireDuration = (input: Duration, what: string, min = 0): string =>
  `${Math.max(min, Math.floor(parseDuration(input, what) / 1000))}s`;

const RAW_HEADER = /[=,]/;
const NAMED_CACHE = new Set(["immutable", "revalidate", "no-store"]);

export const cacheControl = (cache: CacheOption | undefined, visibility: "public" | "private" = "public"): string => {
  if (cache === undefined) return `${visibility}, max-age=3600`;
  if (cache === "immutable") return `${visibility}, max-age=31536000, immutable`;
  if (cache === "revalidate") return `${visibility}, max-age=0, must-revalidate`;
  if (cache === "no-store") return "no-store";
  if (typeof cache === "string" && RAW_HEADER.test(cache)) return cache.trim();
  return `${visibility}, max-age=${Math.floor(parseDuration(cache, "cache") / 1000)}`;
};

export const wireCache = (cache: CacheOption): string => {
  if (typeof cache === "string" && NAMED_CACHE.has(cache)) return cache;
  if (typeof cache === "string" && RAW_HEADER.test(cache)) return cache.trim();
  return wireDuration(cache, "cache");
};
