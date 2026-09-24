import { afterEach, beforeEach, expect, test } from "bun:test";

import { clock } from "../src/browser-clock";
import { deny, forgetFacts, loadFacts } from "../src/react-constraints";
import { ServerUploadTask } from "../src/react-server-upload-task";
import { ListStore, type ListEntry } from "../src/react-task-list";
import { payloadOf } from "../src/react-use-server-upload";

const realFetch = globalThis.fetch;
const realClock = { ...clock };
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  clock.now = () => now;
  clock.frame = (callback) => callback();
  forgetFacts();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(clock, realClock);
});

const serve = (handler: (request: Request) => Response | Promise<Response>) => {
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request);
    return handler(request);
  }, { preconnect: realFetch.preconnect });
  return seen;
};

interface Fake extends ListEntry<{ id: string; status: string }> {
  set(status: string): void;
  started: boolean;
}

const fake = (id: string): Fake => {
  let status = "queued";
  const listeners = new Set<() => void>();
  const entry: Fake = {
    id,
    started: false,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    status: () => status,
    record: () => ({ id, status }),
    start: () => {
      entry.started = true;
      entry.set("uploading");
    },
    set: (next) => {
      status = next;
      listeners.forEach((listener) => listener());
    },
  };
  return entry;
};

test("the list runs 3 uploads at once by default and settled ones free their slot", () => {
  const store = new ListStore<{ id: string; status: string }>();
  const done: string[] = [];
  const failed: string[] = [];
  store.options = { onDone: (record) => done.push(record.id), onError: (record) => failed.push(record.id) };
  const entries = ["a", "b", "c", "d", "e"].map(fake);
  store.add(entries);
  expect(entries.map((entry) => entry.started)).toEqual([true, true, true, false, false]);

  entries[0]?.set("done");
  entries[1]?.set("error");
  expect(entries.map((entry) => entry.started)).toEqual([true, true, true, true, true]);
  expect(done).toEqual(["a"]);
  expect(failed).toEqual(["b"]);

  store.clear("a");
  expect(store.getSnapshot().map((record) => record.id)).toEqual(["b", "c", "d", "e"]);

  const limited = new ListStore<{ id: string; status: string }>();
  limited.options = { concurrency: 1 };
  const pair = [fake("x"), fake("y")];
  limited.add(pair);
  expect(pair.map((entry) => entry.started)).toEqual([true, false]);
});

test("files over maxSize or outside contentTypes are refused before any request", () => {
  const png = new File([new Uint8Array(10)], "a.png", { type: "image/png" });
  expect(deny(png, { maxSize: 5 })).toMatchObject({ code: "too_large" });
  expect(deny(png, { contentTypes: ["application/pdf"] })).toMatchObject({ code: "content_type_not_allowed" });
  expect(deny(new File(["x"], "a.jpg", { type: "image/jpg" }), { contentTypes: ["image/jpeg"] })).toBeUndefined();
  expect(deny(png, { contentTypes: ["image/png"], maxSize: 10 })).toBeUndefined();
  expect(deny(png, undefined)).toBeUndefined();
});

test("constraints are fetched once per route and revalidated with the ETag after 60s", async () => {
  const seen = serve((request) =>
    request.headers.get("if-none-match") === '"v1"'
      ? new Response(null, { status: 304 })
      : Response.json({ constraints: { maxSize: 10 } }, { headers: { etag: '"v1"' } }));
  const [first, second] = await Promise.all([loadFacts("https://app.test/u", undefined), loadFacts("https://app.test/u", undefined)]);
  expect(first).toEqual({ constraints: { maxSize: 10 } });
  expect(second).toBe(first);
  await loadFacts("https://app.test/u", undefined);
  expect(seen).toHaveLength(1);

  now += 61_000;
  expect(await loadFacts("https://app.test/u", undefined)).toEqual({ constraints: { maxSize: 10 } });
  expect(seen).toHaveLength(2);
  expect(seen[1]?.headers.get("if-none-match")).toBe('"v1"');

  serve(() => Response.json({ code: "unauthorized", message: "sign in" }, { status: 401 }));
  expect(await loadFacts("https://app.test/other", undefined)).toMatchObject({ error: { code: "unauthorized" } });
});

test("a server upload posts the file as form data and hands the JSON back unchanged", async () => {
  const bodies: string[] = [];
  serve(async (request) => {
    const form = await request.formData();
    const file = form.get("file");
    bodies.push(file instanceof File ? file.name : "none");
    return Response.json({ id: 7, uploadedAt: "2026-09-24" });
  });
  const file = new File(["hello"], "a.txt");
  const payload = payloadOf({ file }, "file");
  if (!payload) throw new Error("no payload");
  const task = new ServerUploadTask<{ id: number }>({ route: "https://app.test/save", ...payload });
  const changes: string[] = [];
  task.subscribe(() => changes.push(task.snapshot().status));
  task.start();
  while (task.snapshot().pending) await Bun.sleep(1);
  expect(task.snapshot()).toMatchObject({ status: "done", percent: 100, response: { id: 7, uploadedAt: "2026-09-24" } });
  expect(changes).toContain("finishing");
  expect(bodies).toEqual(["a.txt"]);
});

test("server upload errors keep the route's code, and a bare 413 says why", async () => {
  serve(() => Response.json({ code: "invalid_input", message: "bad name", status: 400 }, { status: 400 }));
  const coded = new ServerUploadTask({ route: "https://app.test/save", body: new Blob(["x"]), file: null, total: 1 });
  coded.start();
  while (coded.snapshot().pending) await Bun.sleep(1);
  expect(coded.snapshot()).toMatchObject({ status: "error", error: { code: "invalid_input", message: "Bad name" } });

  serve(() => new Response("too big", { status: 413 }));
  const capped = new ServerUploadTask({ route: "https://app.test/save", body: new Blob(["x"]), file: null, total: 1 });
  capped.start();
  while (capped.snapshot().pending) await Bun.sleep(1);
  expect(capped.snapshot().error).toMatchObject({ code: "too_large", hint: expect.stringContaining("useUpload") });
});
