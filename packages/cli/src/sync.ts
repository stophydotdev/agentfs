import { watch } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type Api, ApiError, type Precondition } from "./api";
import { collect } from "./collect";
import { inParallel, sha256Of } from "./local";
import { fetchVerified } from "./pull";
import { putLocals } from "./put";

const STATE_DIR = ".agentfs";
const DEBOUNCE_MS = 300;
const POLL_SECONDS = 30;
const RETRY_MS = 5000;

const stored = z.object({
  lastEvent: z.string().default(""),
  files: z.record(z.string(), z.string()).default({}),
  conflicts: z.record(z.string(), z.object({ remote: z.string(), local: z.string() })).default({}),
});

type State = z.infer<typeof stored>;

export type Change =
  | { kind: "pulled" | "pushed" | "deleted-local" | "deleted-remote"; path: string }
  | { kind: "conflict"; path: string; copy: string | null }
  | { kind: "failed"; path: string; reason: string };

type Decision = "same" | "pull" | "push" | "delete-local" | "delete-remote" | "conflict";

const decide = (base: string | undefined, local: string | null, remote: string | null): Decision => {
  if (local === remote) return "same";
  if (base === undefined) {
    if (local === null) return "pull";
    return remote === null ? "push" : "conflict";
  }
  if (local === base) return remote === null ? "delete-local" : "pull";
  if (remote === base) return local === null ? "delete-remote" : "push";
  if (local === null) return "pull";
  return remote === null ? "push" : "conflict";
};

const sidecarOf = (path: string) => {
  const extension = extname(path);
  return `${path.slice(0, path.length - extension.length)}.remote${extension}`;
};

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const stateFile = (dir: string) => join(dir, STATE_DIR, "sync.json");

const load = async (dir: string): Promise<State> => {
  const text = await readFile(stateFile(dir), "utf8").catch(() => "{}");
  const parsed = stored.safeParse(JSON.parse(text.trim() === "" ? "{}" : text));
  return parsed.success ? parsed.data : stored.parse({});
};

const place = async (dir: string, target: string, bytes: Uint8Array) => {
  const scratch = join(dir, STATE_DIR, "tmp");
  await mkdir(scratch, { recursive: true });
  const temporary = join(scratch, crypto.randomUUID());
  await writeFile(temporary, bytes);
  await mkdir(dirname(target), { recursive: true });
  await rename(temporary, target);
};

const save = async (dir: string, state: State) => {
  await mkdir(join(dir, STATE_DIR), { recursive: true });
  const temporary = `${stateFile(dir)}.${crypto.randomUUID()}`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, stateFile(dir));
};

const failure = (path: string, error: unknown): Change => ({
  kind: "failed",
  path,
  reason: error instanceof Error ? error.message : String(error),
});

export const syncOnce = async (api: Api, dir: string, prefix: string): Promise<Change[]> => {
  await mkdir(join(dir, STATE_DIR), { recursive: true });
  const root = resolve(dir);
  const state = await load(dir);
  const filter = { path: prefix, agent: "", session: "", op: "" };
  const newest = await api.newestEventId(filter);
  const listing =
    state.lastEvent === "" || newest !== state.lastEvent
      ? new Map((await api.list(prefix)).map((file) => [file.path.slice(prefix.length), file]))
      : null;
  const remoteSha = (path: string) =>
    listing === null ? (state.files[path] ?? null) : (listing.get(path)?.sha256 ?? null);

  const { locals } = await collect([dir], "", false);
  const sidecars = new Set(Object.keys(state.conflicts).map(sidecarOf));
  const candidates = [
    ...new Set([...locals.map((local) => local.path.slice(basename(root).length + 1)), ...Object.keys(state.files)]),
  ].filter((path) => !sidecars.has(path));
  const hashes = new Map(
    await inParallel(candidates, async (path) => [path, await sha256Of(join(dir, path)).catch(() => null)] as const),
  );
  const localSha = (path: string) => hashes.get(path) ?? null;
  const inside = (path: string) => !relative(root, resolve(root, path)).startsWith("..");

  const groups: Record<Decision, string[]> = {
    same: [],
    pull: [],
    push: [],
    "delete-local": [],
    "delete-remote": [],
    conflict: [],
  };
  const untouched = new Set<string>();
  for (const path of new Set([...candidates, ...(listing?.keys() ?? [])])) {
    const local = localSha(path);
    const remote = remoteSha(path);
    let decision = decide(state.files[path], local, remote);
    if (decision === "conflict") {
      const known = state.conflicts[path];
      const sidecarPresent = await exists(join(dir, sidecarOf(path)));
      if (known?.remote === remote && (known.local !== local || !sidecarPresent)) decision = "push";
      else if (known?.remote === remote && known.local === local) untouched.add(path);
    }
    groups[decision].push(path);
  }

  const changes: Change[] = [];
  const settle = async (path: string) => {
    if (state.conflicts[path] === undefined) return;
    delete state.conflicts[path];
    await rm(join(dir, sidecarOf(path)), { force: true });
  };

  for (const path of groups.same) {
    const local = localSha(path);
    if (local === null) delete state.files[path];
    else state.files[path] = local;
    await settle(path);
  }

  await inParallel(groups.conflict, async (path) => {
    const remote = listing?.get(path);
    const local = localSha(path);
    if (remote === undefined || local === null || !inside(path)) return;
    if (untouched.has(path)) {
      changes.push({ kind: "conflict", path, copy: sidecarOf(path) });
      return;
    }
    try {
      await place(dir, join(dir, sidecarOf(path)), await fetchVerified(api, remote));
      state.conflicts[path] = { remote: remote.sha256, local };
      changes.push({ kind: "conflict", path, copy: sidecarOf(path) });
    } catch (error) {
      changes.push(failure(path, error));
    }
  });

  await inParallel(groups.pull, async (path) => {
    const remote = listing?.get(path);
    if (remote === undefined || !inside(path)) return;
    try {
      if ((await sha256Of(join(dir, path)).catch(() => null)) !== localSha(path)) {
        throw new Error("changed locally while syncing; the next pass will retry");
      }
      await place(dir, join(dir, path), await fetchVerified(api, remote));
      state.files[path] = remote.sha256;
      await settle(path);
      changes.push({ kind: "pulled", path });
    } catch (error) {
      changes.push(failure(path, error));
    }
  });

  await inParallel(groups["delete-local"], async (path) => {
    if (!inside(path)) return;
    try {
      if ((await sha256Of(join(dir, path)).catch(() => null)) !== state.files[path]) {
        throw new Error("changed locally while syncing; the next pass will retry");
      }
      await rm(join(dir, path), { force: true });
      delete state.files[path];
      changes.push({ kind: "deleted-local", path });
    } catch (error) {
      changes.push(failure(path, error));
    }
  });

  await inParallel(groups["delete-remote"], async (path) => {
    try {
      const synced = state.files[path];
      const precondition: Precondition = synced === undefined ? { kind: "none" } : { kind: "match", etag: synced };
      await api.remove(`${prefix}${path}`, precondition).catch((error: unknown) => {
        if (!(error instanceof ApiError && error.code === "not_found")) throw error;
      });
      delete state.files[path];
      changes.push({ kind: "deleted-remote", path });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "precondition_failed")) {
        changes.push(failure(path, error));
        return;
      }
      try {
        const remote = await api.stat(`${prefix}${path}`);
        if (remote === null) {
          delete state.files[path];
          changes.push({ kind: "deleted-remote", path });
          return;
        }
        if (await exists(join(dir, path))) throw new Error("recreated locally while syncing; the next pass will decide");
        await place(dir, join(dir, path), await fetchVerified(api, remote));
        state.files[path] = remote.sha256;
        changes.push({ kind: "pulled", path });
      } catch (pullError) {
        changes.push(failure(path, pullError));
      }
    }
  });

  if (groups.push.length > 0) {
    const outcomes = await putLocals(
      api,
      groups.push.map((path) => ({ file: join(dir, path), path: `${prefix}${path}` })),
      { force: false, ttlSeconds: undefined, expected: new Map(groups.push.map((path) => [`${prefix}${path}`, remoteSha(path)])) },
    );
    for (const outcome of outcomes) {
      if (outcome.kind === "failed") changes.push(failure(outcome.path.slice(prefix.length), outcome.reason));
      else if (outcome.kind === "conflict") {
        changes.push({ kind: "conflict", path: outcome.path.slice(prefix.length), copy: null });
      } else {
        const path = outcome.file.path.slice(prefix.length);
        state.files[path] = outcome.file.sha256;
        await settle(path);
        if (outcome.kind !== "unchanged") changes.push({ kind: "pushed", path });
      }
    }
  }

  const retry = changes.some((change) => change.kind === "failed" || (change.kind === "conflict" && change.copy === null));
  state.lastEvent = retry ? "" : newest;
  await save(dir, state);
  return changes;
};

export const watchLoop = async (api: Api, dir: string, prefix: string, pass: () => Promise<number>) => {
  const filter = { path: prefix, agent: "", session: "", op: "" };
  let stopping = false;
  let dirty = false;
  let wake = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ping = () => {
    dirty = true;
    wake();
  };
  const next = async () => {
    while (!dirty && !stopping) await new Promise<void>((done) => (wake = done));
    dirty = false;
  };
  const watcher = watch(dir, { recursive: true }, (_event, name) => {
    if (name === STATE_DIR || name?.startsWith(`${STATE_DIR}${sep}`) || name?.startsWith(`${STATE_DIR}/`)) return;
    clearTimeout(timer);
    timer = setTimeout(ping, DEBOUNCE_MS);
  });
  const stop = () => {
    stopping = true;
    ping();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let cursor = await api.newestEventId(filter);
  const poll = async () => {
    while (!stopping) {
      try {
        const page = await api.eventsAfter(filter, cursor, POLL_SECONDS);
        cursor = page.cursor ?? cursor;
        if (page.events.length > 0) ping();
      } catch (error) {
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        await new Promise((done) => setTimeout(done, RETRY_MS));
      }
    }
  };
  void poll();
  let code = await pass();
  while (!stopping) {
    await next();
    if (!stopping) code = await pass();
  }
  watcher.close();
  clearTimeout(timer);
  return code;
};
