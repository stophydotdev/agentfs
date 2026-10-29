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
    throw new Error(`use a size like 500MB or 5GB, not "${text}"`);
  }
  return Math.round(Number(match[1]) * factor);
};

export const formatBytes = (bytes: number) => {
  const [unit, factor] = [...UNITS].findLast(([, size]) => bytes >= size) ?? ["B", 1];
  return `${Number((bytes / factor).toFixed(1))} ${unit}`;
};
