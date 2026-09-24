import { afterEach, beforeEach, expect, test } from "bun:test";

import { upload } from "../src/browser";
import { clock } from "../src/browser-clock";
import { poolState } from "../src/browser-pool";
import { CORS_HINT } from "../src/browser-task";

const realFetch = globalThis.fetch;
const realClock = { ...clock };
let sleeps: number[] = [];
let now = 1_000_000;

beforeEach(() => {
  sleeps = [];
  now = 1_000_000;
  clock.now = () => now;
  clock.random = () => 1;
  clock.sleep = async (ms) => {
    sleeps.push(ms);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(clock, realClock);
  Reflect.deleteProperty(globalThis, "localStorage");
});

type Storage = (request: Request, n: number) => Response | Promise<Response>;

const aborted = (request: Request): Promise<Response> =>
  new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

const world = (file: { size: number; partSize: number; multipart?: boolean; landed?: number[] }, storage: Storage, route?: (body: { phase: string }) => Response | undefined) => {
  const calls: string[] = [];
  const puts: number[] = [];
  const count = file.multipart === false ? 1 : Math.ceil(file.size / file.partSize);
  const parts = (from: number) => Array.from({ length: Math.max(0, count - from + 1) }, (_, i) => ({ n: from + i, url: `https://r2.test/p${from + i}` }));
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host === "r2.test") {
      const n = Number(url.pathname.slice(2));
      puts.push(n);
      return Promise.race([storage(request, n), aborted(request)]);
    }
    const body = await request.json();
    const phase: string = body.phase;
    calls.push(phase === "parts" ? `parts:${body.from}` : phase);
    const custom = route?.(body);
    if (custom) return custom;
    const plan = { partSize: file.multipart === false ? file.size : file.partSize, multipart: file.multipart !== false };
    if (phase === "begin") return Response.json({ completionToken: "tok", path: "a.bin", upload: { ...plan, parts: parts(1) } });
    if (phase === "parts") return Response.json({ ...plan, size: file.size, parts: parts(body.from), landed: (file.landed ?? []).map((n) => ({ n, etag: `e${n}` })) });
    if (phase === "end") return Response.json({ blob: { path: "a.bin", size: file.size, etag: "e", uploadedAt: "2026-09-24T00:00:00.000Z", contentType: "application/octet-stream" }, data: { ok: true } });
    return Response.json({});
  }, { preconnect: realFetch.preconnect });
  return { calls, puts };
};

const ok = () => new Response(null, { status: 200, headers: { etag: '"x"' } });
const bytes = (size: number) => new File([new Uint8Array(size)], "a.bin");

test("a 503 with Retry-After is retried after the server's delay", async () => {
  let failures = 2;
  const io = world({ size: 4, partSize: 4, multipart: false }, () => (failures-- > 0 ? new Response(null, { status: 503, headers: { "retry-after": "2" } }) : ok()));
  const done = await upload(bytes(4), { route: "https://app.test/u" }).done;
  expect(done.data).toEqual({ ok: true });
  expect(io.puts).toEqual([1, 1, 1]);
  expect(sleeps).toEqual([2000, 2000]);
});

test("a part gives up after 8 HTTP attempts with jittered backoff capped at 15s", async () => {
  world({ size: 4, partSize: 4, multipart: false }, () => new Response(null, { status: 500 }));
  const task = upload(bytes(4), { route: "https://app.test/u" });
  await expect(task.done).rejects.toMatchObject({ code: "request_failed", message: expect.stringContaining("after 8 attempts") });
  expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
});

test("a network failure before any byte is sent stops after 3 attempts with the CORS hint", async () => {
  const io = world({ size: 4, partSize: 4, multipart: false }, () => {
    throw new TypeError("Failed to fetch");
  });
  const task = upload(bytes(4), { route: "https://app.test/u" });
  await expect(task.done).rejects.toMatchObject({ hint: CORS_HINT, message: expect.stringContaining("CORS") });
  expect(io.puts).toHaveLength(3);
});

test("a part silent for 60s is aborted and retried, and a task whose parts all back off is stalled", async () => {
  const timers: number[] = [];
  clock.timer = (ms, callback) => {
    timers.push(ms);
    if (timers.length > 1) return () => {};
    const handle = setTimeout(callback, 0);
    return () => clearTimeout(handle);
  };
  let first = true;
  const io = world({ size: 4, partSize: 4, multipart: false }, () => {
    if (!first) return ok();
    first = false;
    return new Promise<Response>(() => {});
  });
  let stalledDuringBackoff = false;
  const task = upload(bytes(4), { route: "https://app.test/u" });
  clock.sleep = async (ms) => {
    sleeps.push(ms);
    stalledDuringBackoff = task.snapshot().stalled;
  };
  await task.done;
  expect(timers).toContain(60_000);
  expect(io.puts).toEqual([1, 1]);
  expect(stalledDuringBackoff).toBe(true);
  expect(task.snapshot().stalled).toBe(false);
});

test("every task on the page shares 6 requests, and one task keeps 4 parts in flight", async () => {
  let active = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  world({ size: 8, partSize: 1 }, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => release.push(resolve));
    active -= 1;
    return ok();
  });
  const drain = async (until: () => boolean) => {
    while (!until()) {
      await Bun.sleep(1);
      release.splice(0).forEach((go) => go());
    }
  };

  const solo = upload(bytes(8), { route: "https://app.test/u" });
  let soloDone = false;
  void solo.done.then(() => (soloDone = true));
  await Bun.sleep(5);
  expect(active).toBe(4);
  await drain(() => soloDone);
  expect(peak).toBe(4);

  peak = 0;
  const tasks = [upload(bytes(8), { route: "https://app.test/u" }), upload(bytes(8), { route: "https://app.test/u" })];
  let settled = false;
  void Promise.all(tasks.map((task) => task.done)).then(() => (settled = true));
  await Bun.sleep(5);
  expect(active).toBe(6);
  expect(poolState()).toEqual({ active: 6, waiting: 2 });
  await drain(() => settled);
  expect(peak).toBe(6);
});

test("a part url older than 60s is re-signed before the next PUT", async () => {
  let failed = false;
  const io = world({ size: 4, partSize: 4, multipart: false }, () => {
    if (failed) return ok();
    failed = true;
    return new Response(null, { status: 500 });
  });
  clock.sleep = async () => {
    now += 61_000;
  };
  await upload(bytes(4), { route: "https://app.test/u" }).done;
  expect(io.calls).toEqual(["begin", "parts:1", "end"]);
  expect(io.puts).toEqual([1, 1]);
});

test("a 403 from storage re-signs the part once", async () => {
  let refused = false;
  const io = world({ size: 8, partSize: 4 }, (_, n) => {
    if (n !== 2 || refused) return ok();
    refused = true;
    return new Response(null, { status: 403 });
  });
  await upload(bytes(8), { route: "https://app.test/u" }).done;
  expect(io.calls).toEqual(["begin", "parts:2", "end"]);
  expect(io.puts.sort()).toEqual([1, 2, 2]);

  world({ size: 4, partSize: 4, multipart: false }, () => new Response(null, { status: 403 }));
  await expect(upload(bytes(4), { route: "https://app.test/u" }).done).rejects.toMatchObject({ code: "signature_mismatch" });
});

test("route errors keep the code and hint the route answered with", async () => {
  world({ size: 4, partSize: 4, multipart: false }, ok, (body) =>
    body.phase === "begin" ? Response.json({ code: "content_type_not_allowed", message: "no pdfs", status: 415, hint: "send a png" }, { status: 415 }) : undefined);
  await expect(upload(bytes(4), { route: "https://app.test/u" }).done).rejects.toMatchObject({ code: "content_type_not_allowed", status: 415, hint: "send a png" });

  world({ size: 4, partSize: 4, multipart: false }, ok, (body) => (body.phase === "begin" ? new Response("nope", { status: 404 }) : undefined));
  await expect(upload(bytes(4), { route: "https://app.test/u" }).done).rejects.toMatchObject({ code: "not_found", status: 404 });
});

test("picking the same file after a reload resumes from the parts that landed", async () => {
  const saved = new Map<string, string>();
  Reflect.set(globalThis, "localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  const file = bytes(8);
  saved.set(`agentfs-blob:v1:https://app.test/u|a.bin|8|${file.lastModified}`, JSON.stringify({ completionToken: "tok" }));
  const io = world({ size: 8, partSize: 4, landed: [1] }, ok);
  const task = upload(file, { route: "https://app.test/u" });
  await task.done;
  expect(io.calls).toEqual(["parts:1", "end"]);
  expect(io.puts).toEqual([2]);
  expect(saved.size).toBe(0);
});

test("pause holds the queue, resume finishes it, cancel tells the route", async () => {
  const release: (() => void)[] = [];
  const io = world({ size: 8, partSize: 1 }, async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    return ok();
  });
  const task = upload(bytes(8), { route: "https://app.test/u" });
  await Bun.sleep(5);
  expect(task.snapshot().canPause).toBe(true);
  expect(task.pause()).toBe(true);
  expect(task.snapshot().status).toBe("paused");
  release.splice(0);
  const sent = io.puts.length;
  await Bun.sleep(5);
  expect(io.puts).toHaveLength(sent);
  expect(task.resume()).toBe(true);
  while (task.snapshot().pending) {
    await Bun.sleep(1);
    release.splice(0).forEach((go) => go());
  }
  expect(task.snapshot().status).toBe("done");
  expect(new Set(io.puts).size).toBe(8);

  const canceled = upload(bytes(8), { route: "https://app.test/u" });
  await Bun.sleep(5);
  expect(canceled.cancel()).toBe(true);
  await expect(canceled.done).rejects.toMatchObject({ name: "AbortError" });
  await Bun.sleep(5);
  expect(io.calls.at(-1)).toBe("cancel");
  release.splice(0).forEach((go) => go());
});
