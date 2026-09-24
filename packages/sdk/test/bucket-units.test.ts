import { expect, test } from "bun:test";

import { cacheControl, formatBytes, parseDuration, parseSize, wireCache, wireDuration } from "../src/units";

test("parseSize reads decimal units with spaces and any case, and bare numbers as bytes", () => {
  expect(parseSize("2mb")).toBe(2_000_000);
  expect(parseSize(" 1.5 KB ")).toBe(1500);
  expect(parseSize("10")).toBe(10);
  expect(parseSize(7.9)).toBe(7);
  expect(() => parseSize("2 mib")).toThrow(TypeError);
  expect(() => parseSize("big")).toThrow(TypeError);
  expect(() => parseSize(-1)).toThrow(TypeError);
});

test("parseDuration returns milliseconds and takes word units and bare seconds", () => {
  expect(parseDuration("2 hours")).toBe(7_200_000);
  expect(parseDuration("500ms")).toBe(500);
  expect(parseDuration("15M")).toBe(900_000);
  expect(parseDuration(90)).toBe(90_000);
  expect(parseDuration("90")).toBe(90_000);
  expect(() => parseDuration("1w")).toThrow(TypeError);
  expect(() => parseDuration("soon")).toThrow(TypeError);
});

test("formatBytes prints whole multiples whole and never 1000 of a unit", () => {
  expect(formatBytes(2_000_000)).toBe("2 MB");
  expect(formatBytes(1_500_000)).toBe("1.5 MB");
  expect(formatBytes(999_960)).toBe("1.0 MB");
  expect(formatBytes(12_345_678)).toBe("12 MB");
  expect(formatBytes(512)).toBe("512 B");
});

test("the server gets named cache options and raw headers as written, durations as seconds", () => {
  expect(wireCache("immutable")).toBe("immutable");
  expect(wireCache("public, s-maxage=60")).toBe("public, s-maxage=60");
  expect(wireCache("2 hours")).toBe("7200s");
  expect(wireCache(90)).toBe("90s");
  expect(wireDuration("1h", "expiresIn")).toBe("3600s");
  expect(wireDuration("500ms", "expiresIn", 1)).toBe("1s");
});

test("cacheControl matches Upstash's header for each option", () => {
  expect(cacheControl(undefined)).toBe("public, max-age=3600");
  expect(cacheControl("immutable", "private")).toBe("private, max-age=31536000, immutable");
  expect(cacheControl("revalidate")).toBe("public, max-age=0, must-revalidate");
  expect(cacheControl("no-store")).toBe("no-store");
  expect(cacheControl("15m")).toBe("public, max-age=900");
  expect(cacheControl(" max-age=5 ")).toBe("max-age=5");
});
