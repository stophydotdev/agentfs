import { rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { version } from "../package.json";
import {
  type Api,
  ApiError,
  type Precondition,
  type FileEvent,
  type Json,
  type RemoteFile,
  baseUrl,
  connect,
  findKey,
  keyFile,
  report,
  saveKey,
  setCommand,
} from "./api";
import { exportDatabase } from "./export";
import { folder } from "./folder";
import { importDatabase } from "./import";
import { type PullOutcome, pull } from "./pull";
import { type PutOutcome, put } from "./put";
import { exec, localFolder, parentOf } from "./run";
import { type Change, syncOnce, watchLoop } from "./sync";
import { UsageError } from "./usage-error";
import { formatBytes, parseBytes, parseDuration } from "./units";

const USAGE = `agentfs ${version}: upload files and get links

  agentfs put <file or folder>... [--to folder]  upload; unchanged and known bytes are not sent
              [--force] [--ttl 1d]               --force overwrites a file changed remotely; --ttl deletes the files after that long
              [--private | --public]             --private gives no public link; a private file stays private until --public
  agentfs sign <path> [--ttl 5m]                 a link that opens a file without a key, for 5 minutes by default and at most 1h
  agentfs pull <folder> [into]                   download; unchanged files are skipped
  agentfs ls [folder] [-r] [--by agent]          list one level, folders first; -r lists everything below
            [--search text]                      files below the folder whose path has the text, any case
  agentfs stat <path>                            size, type, sha256, last modified, agent, session, commit, link
  agentfs mv <from> <to> [--yes]                 move a file or a folder (a folder ends in /)
  agentfs undelete <path>                        bring back a file deleted in the last 7 days
  agentfs rm <path>...                           delete files
  agentfs rm -r <folder>... [--yes]              delete everything under a folder
  agentfs snapshot <name> [folder]               save a folder, or everything, as a named snapshot
  agentfs snapshot ls                            list snapshots
  agentfs snapshot rm <name>                     delete a snapshot
  agentfs restore <name|last> [--to folder] [--yes]  make the folder exactly the snapshot again
  agentfs diff <snapshot|last> [snapshot]        added, changed and removed paths; one name compares with now
  agentfs timeline [path] [--by agent] [--session id] [--op op] [--follow]  events, newest first; --follow waits for new ones
  agentfs kv get <key>                           read a value
  agentfs kv set <key> <json or ->               store JSON, or text as a string; - reads stdin
              [--if-version n] [--create-only] [--ttl 1h]  only if the version matches, or only if new
  agentfs kv rm <key> [--if-version n] [--yes]   delete a value
  agentfs kv ls [prefix]                         list keys with their versions and values
  agentfs log <name> [--input json] [--output json] [--status ok|error] [--duration ms]  record a tool call
  agentfs import <file.db> [--to folder]         bring in a Turso AgentFS database: files, kv and tool calls
  agentfs export <folder> <file.db>              write a Turso AgentFS database from a folder and its kv
  agentfs usage [--by agent|session|commit]      files, bytes and writes per label
  agentfs sync <dir> <folder> [--watch]          mirror a local dir and a remote folder both ways; a clash keeps both
  agentfs run [--in folder]... [--out folder]... [--timeout 30m] -- <command...>  pull, run, put; exits with the command's code
  agentfs fork <folder> <new folder>             copy a folder without sending any bytes
  agentfs limits [--cap 5GB]                     show usage and limits, or set a storage cap
  agentfs claim                                  get a link for your person to keep these files
  agentfs status [--check]                       key, account, plan, usage; --check only sets the exit code
  agentfs login --key-stdin                      save a key read from stdin
  agentfs logout                                 delete the saved key
  agentfs key rotate                             replace your key; the old one stops working
  agentfs key list                               list the keys made for this account
  agentfs key revoke <id>                        stop a key from working
  agentfs key create [--prefix folder] [--read] [--write] [--delete] [--ttl 1h]  make a key limited to a folder
  agentfs mcp [--prefix folder] [--ttl 1d]       print the MCP config; --prefix makes a key for that folder (read and write,
              [--read] [--write] [--delete]      or the ones you name) instead of using your full key
  agentfs feedback <message>                     tell the agentfs team what slows you down
  agentfs report <url> <reason>                  report a file that breaks the rules; no key needed

Output is one JSON object per line when stdout is not a terminal; --no-json forces text, --json forces JSON.
Piped put and ls print only path, url, and status or size; --json prints every field.
Exit codes: 1 error, 2 usage error, 3 conflict (put, sync), 124 timeout (run). Also: --api-url url.
Deleting or overwriting asks first in a terminal; elsewhere add --yes. In a git repo, put skips what .gitignore ignores.
Files that look like secrets (.env, keys) are skipped unless you add --include-secrets.
`;

const usageFor = (command: string) => {
  let current = "";
  return USAGE.split("\n").filter((line) => {
    const start = /^ {2}agentfs (\S+)/u.exec(line);
    if (start !== null) current = start[1] ?? "";
    else if (!/^ {6,}\S/u.test(line)) current = "";
    return current === command;
  });
};

/** Commands the 0.0.2 CLI and the old skill used, with the line that names what to run now. */
const RENAMED = new Map([
  ["upload", "agentfs upload is now agentfs put. Run: agentfs put <file or folder>... [--to folder]"],
  ["share", "agentfs share is now agentfs sign. Run: agentfs sign <path> [--ttl 5m]"],
  ["init", "agentfs init is gone: any command signs you up. To use a key you have, run: agentfs login --key-stdin"],
]);

const MIN_ARGS = new Map([
  ["put", 1],
  ["sign", 1],
  ["pull", 1],
  ["ls", 0],
  ["stat", 1],
  ["mv", 2],
  ["rm", 1],
  ["snapshot", 1],
  ["restore", 1],
  ["diff", 1],
  ["timeline", 0],
  ["undelete", 1],
  ["usage", 0],
  ["kv", 1],
  ["log", 1],
  ["import", 1],
  ["export", 2],
  ["run", 1],
  ["sync", 2],
  ["status", 0],
  ["login", 0],
  ["logout", 0],
  ["report", 2],
  ["fork", 2],
  ["limits", 0],
  ["claim", 0],
  ["key", 1],
  ["mcp", 0],
  ["feedback", 1],
]);

const OPTIONS = {
    to: { type: "string", default: "" },
    by: { type: "string", default: "" },
    cap: { type: "string" },
    session: { type: "string", default: "" },
    force: { type: "boolean", default: false },
    follow: { type: "boolean", default: false },
    op: { type: "string", default: "" },
    input: { type: "string" },
    output: { type: "string" },
    status: { type: "string", default: "ok" },
    duration: { type: "string", default: "0" },
    "if-version": { type: "string" },
    "create-only": { type: "boolean", default: false },
    ttl: { type: "string" },
    private: { type: "boolean", default: false },
    public: { type: "boolean", default: false },
    prefix: { type: "string", default: "" },
    search: { type: "string" },
    read: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    delete: { type: "boolean", default: false },
    in: { type: "string", multiple: true },
    out: { type: "string", multiple: true },
    recursive: { type: "boolean", short: "r", default: false },
    json: { type: "boolean", default: false },
    "no-json": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    timeout: { type: "string" },
    "api-url": { type: "string" },
    "key-stdin": { type: "boolean", default: false },
    "include-secrets": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
} as const;

const parsed = (() => {
  try {
    return parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(2);
  }
})();
const { positionals, values } = parsed;
if (values["api-url"] !== undefined) process.env.AGENTFS_URL = values["api-url"];
const json = values["no-json"] ? false : values.json || !process.stdout.isTTY;
const brief = json && !values.json;

const print = (line: string) => process.stdout.write(`${line}\n`);

process.stdout.on("error", (error) => {
  if ("code" in error && error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

const OUTCOME_ORDER = ["uploaded", "linked", "downloaded", "unchanged", "conflict", "failed"];

const summarize = (started: number, outcomes: { kind: string }[]) => {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
  const parts = OUTCOME_ORDER.filter((kind) => counts.has(kind)).map(
    (kind) => `${counts.get(kind)} ${kind}`,
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  process.stderr.write(`${parts.join(", ") || "nothing to do"} in ${seconds}s\n`);
  if (counts.has("failed")) process.exitCode = 1;
  else if (counts.has("conflict")) process.exitCode = 3;
};

const linkOf = (file: RemoteFile) => file.url ?? "private";

const hiddenOf = () => {
  if (values.private && values.public) throw new UsageError("use --private or --public, not both");
  if (values.private) return true;
  return values.public ? false : undefined;
};

const printFile = (file: RemoteFile) => {
  const by = [file.agent ?? "-", file.commit ?? "-"].join("\t");
  if (!json) return print(`${file.path}\t${formatBytes(file.size)}\t${by}\t${linkOf(file)}`);
  print(JSON.stringify(brief ? { path: file.path, size: file.size, url: file.url } : file));
};

const hasEntries = async (api: Api, prefix: string) => {
  const { files, folders } = await api.browse(prefix, "/");
  return files.length + folders.length > 0;
};

const isFolder = async (api: Api, path: string) => {
  if (path.endsWith("/")) return true;
  if ((await api.stat(path)) !== null) return false;
  return hasEntries(api, `${path}/`);
};

const byAgent = (file: RemoteFile) => values.by === "" || file.agent === values.by;

/** Older servers answer 204 when deleting a file that is not there, so look first. A key that cannot read still gets to try the delete. */
const isMissing = (api: Api, path: string) =>
  api.stat(path).then(
    (file) => file === null,
    (error: Error) => {
      if (error instanceof ApiError && error.status === 403) return false;
      throw error;
    },
  );

const PERMISSIONS = ["read", "write", "delete"] as const;
const USAGE_LABELS = ["agent", "session", "commit"];

const ttlOf = () => (values.ttl === undefined ? undefined : parseDuration(values.ttl));

const printEvent = (event: FileEvent) => {
  const who = [event.agent ?? "-", event.session ?? "-", event.commit ?? "-"];
  if (json) return print(JSON.stringify(event));
  if (event.op === "tool") {
    return print([event.at, `tool ${event.name} ${event.status} ${event.durationMs}ms`, ...who].join("\t"));
  }
  const path = event.path ?? "-";
  print([event.at, event.op, event.from === null ? path : `${event.from} -> ${path}`, ...who].join("\t"));
};

const asJson = (text: string): Json => {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return text.replace(/\n$/u, "");
  }
};

const readStdin = async () => {
  const parts: Buffer[] = [];
  for await (const part of process.stdin) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString("utf8");
};

const confirm = async (what: string) => {
  if (values.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new UsageError(`${what}, and there is no terminal to ask. Add --yes to go ahead.`);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await terminal.question(`${what}. Continue? [y/N] `);
  terminal.close();
  if (!/^y(es)?$/iu.test(answer.trim())) throw new Error("cancelled");
};

const snapshotNamed = async (api: Api, name: string) => {
  if (name !== "last") return name;
  const newest = (await api.snapshots()).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (newest === undefined) throw new Error("there are no snapshots yet");
  return newest.name;
};

const failWith = (error: Error) => {
  if (json) {
    const api = error instanceof ApiError ? error : null;
    const code = api?.code ?? (error instanceof UsageError ? "usage" : "error");
    print(
      JSON.stringify({
        event: "error",
        code,
        message: api?.detail ?? error.message,
        status: api?.status ?? null,
        requestId: api?.requestId ?? null,
      }),
    );
  } else {
    process.stderr.write(`error: ${error.message}\n`);
    if (error instanceof ApiError && (error.code === "key_revoked" || error.code === "key_expired")) {
      process.stderr.write(`If this account expired, delete ${keyFile} and run again to sign up.\n`);
    }
  }
  return error instanceof UsageError ? 2 : 1;
};

const whole = (text: string, label: string) => {
  if (!/^\d+$/u.test(text)) throw new UsageError(`${label} must be a whole number, not "${text}"`);
  return Number(text);
};

const kvGuard = (): Precondition => {
  if (values["create-only"] && values["if-version"] !== undefined) {
    throw new UsageError("use --create-only or --if-version, not both");
  }
  if (values["create-only"]) return { kind: "absent" };
  const version = values["if-version"];
  return version === undefined ? { kind: "none" } : { kind: "match", etag: String(whole(version, "--if-version")) };
};

const upload = async (api: Api, args: string[], to: string, ttlSeconds: number | undefined) => {
  const started = performance.now();
  const { outcomes, skipped } = await put(api, args, {
    to,
    includeSecrets: values["include-secrets"],
    force: values.force,
    ttlSeconds,
    private: hiddenOf(),
  });
  if (skipped.length > 0) {
    process.stderr.write(
      `skipped ${skipped.length} files that look like secrets: ${skipped.join(", ")}. Add --include-secrets to upload them.\n`,
    );
  }
  for (const outcome of outcomes) {
    if (outcome.kind === "failed") process.stderr.write(`error: ${outcome.path}: ${outcome.reason}\n`);
    else if (outcome.kind === "conflict") {
      process.stderr.write(
        `conflict: ${outcome.path}: changed remotely while uploading, not uploaded. Add --force to overwrite.\n`,
      );
    } else if (!json) print(outcome.file.url ?? `${outcome.file.path} (private, no public link)`);
    else {
      const { path, url } = outcome.file;
      print(JSON.stringify({ ...(brief ? { path, url } : outcome.file), status: outcome.kind }));
    }
  }
  summarize(started, outcomes);
  return outcomes;
};

const syncSummary = (started: number, changes: Change[]) => {
  const count = (...kinds: Change["kind"][]) => changes.filter((change) => kinds.includes(change.kind)).length;
  const done = {
    pulled: count("pulled"),
    pushed: count("pushed"),
    deleted: count("deleted-local", "deleted-remote"),
    conflicts: count("conflict"),
    failed: count("failed"),
  };
  const seconds = (performance.now() - started) / 1000;
  if (json) print(JSON.stringify({ event: "summary", ...done, seconds: Number(seconds.toFixed(2)) }));
  else {
    const parts = Object.entries(done).filter(([, total]) => total > 0).map(([name, total]) => `${total} ${name}`);
    process.stderr.write(`${parts.join(", ") || "nothing to do"} in ${seconds.toFixed(2)}s\n`);
  }
  if (done.failed > 0) return 1;
  return done.conflicts > 0 ? 3 : 0;
};

const sizeOf = (bytes: number | null) => (bytes === null ? "no limit" : formatBytes(bytes));

const tierLine = (limits: Awaited<ReturnType<Api["limits"]>>) => {
  if (limits.tier === "unclaimed") {
    return `tier unclaimed: ${sizeOf(limits.maxCapBytes)} max, deleted 24 hours after the first upload. Run agentfs claim to keep it.`;
  }
  if (limits.ownerUsedBytes === null) return `plan ${limits.plan}`;
  const used = formatBytes(limits.ownerUsedBytes);
  const of = limits.ownerLimitBytes === null ? "" : ` of ${formatBytes(limits.ownerLimitBytes)}`;
  return `plan ${limits.plan}: ${used}${of} used across your accounts`;
};

/** The key the MCP config carries: a new one limited to --prefix, or the key this command runs with. */
const mcpKey = async (api: Api) => {
  if (values.prefix === "") {
    const { key } = await api.limits();
    const about = key.scoped
      ? `the scoped key you ran this with: ${key.prefix || "everything"}, ${key.permissions.join(",")}.`
      : "your full key, which opens every folder and can do everything. For one folder, add --prefix <folder>.";
    return { key: api.key, about };
  }
  const permissions = PERMISSIONS.filter((permission) => values[permission]);
  const made = await api.createKey(folder(values.prefix), permissions.length === 0 ? ["read", "write"] : permissions, ttlOf());
  const about = `a new scoped key, ${made.id}: ${made.prefix || "everything"}, ${made.permissions.join(",")}, ends ${made.expiresAt ?? "never"}. Stop it with agentfs key revoke ${made.id}.`;
  return { key: made.key, about };
};

const commands = {
  put: async (api: Api, args: string[]) => upload(api, args, values.to, ttlOf()),
  pull: async (api: Api, [folder = "", into = "."]: string[]) => {
    const started = performance.now();
    const outcomes = await pull(api, folder, into);
    for (const outcome of outcomes) {
      if (outcome.kind === "failed") process.stderr.write(`error: ${outcome.path}: ${outcome.reason}\n`);
      else print(json ? JSON.stringify(outcome) : outcome.target);
    }
    summarize(started, outcomes);
  },
  ls: async (api: Api, [path = ""]: string[]) => {
    if (values.search !== undefined) {
      const needle = values.search.toLowerCase();
      const found = await api.list(folder(path), values.search);
      for (const file of found.filter(byAgent).filter((file) => file.path.toLowerCase().includes(needle))) printFile(file);
      return;
    }
    if (values.recursive) {
      for (const file of (await api.list(path)).filter(byAgent)) printFile(file);
      return;
    }
    const { files, folders } = await api.browse(folder(path), "/");
    for (const name of folders) print(json ? JSON.stringify({ path: name, kind: "folder" }) : name);
    for (const file of files.filter(byAgent)) printFile(file);
  },
  stat: async (api: Api, [path = ""]: string[]) => {
    const file = await api.stat(path);
    if (file === null) throw new ApiError("not_found", `no file at ${path}`);
    if (json) return print(JSON.stringify(file));
    print(`path      ${file.path}`);
    print(`size      ${formatBytes(file.size)}`);
    print(`type      ${file.contentType}`);
    print(`sha256    ${file.sha256}`);
    print(`modified  ${file.updatedAt}`);
    print(`expires   ${file.expiresAt ?? "-"}`);
    print(`verified  ${file.verified}`);
    print(`agent     ${file.agent ?? "-"}`);
    print(`session   ${file.session ?? "-"}`);
    print(`commit    ${file.commit ?? "-"}`);
    print(`private   ${file.private}`);
    print(`link      ${file.url ?? "none, the file is private"}`);
  },
  mv: async (api: Api, [from = "", to = ""]: string[]) => {
    const asFolder = await isFolder(api, from);
    const [source, target] = asFolder ? [folder(from), folder(to)] : [from, to];
    const taken = asFolder ? await hasEntries(api, target) : (await api.stat(target)) !== null;
    if (taken) await confirm(`${to} already exists, and moving ${from} there overwrites it`);
    const moved = await api.move(source, target);
    print(json ? JSON.stringify(moved) : `${moved.from} -> ${moved.to} (${moved.moved} files)`);
  },
  rm: async (api: Api, paths: string[]) => {
    if (values.recursive) {
      const prefixes = paths.map(folder);
      if (prefixes.includes("")) throw new UsageError("rm -r needs a folder");
      await confirm(`this deletes everything under ${prefixes.join(", ")}`);
      for (const prefix of prefixes) {
        const removed = await api.removeFolder(prefix);
        print(json ? JSON.stringify(removed) : `${removed.deleted} files deleted from ${removed.prefix}`);
      }
      return;
    }
    for (const path of paths) {
      const missing =
        (await isMissing(api, path)) ||
        (await api.remove(path).then(
          () => false,
          (error: Error) => {
            if (error instanceof ApiError && error.code === "not_found") return true;
            throw error;
          },
        ));
      if (missing) process.exitCode = failWith(new ApiError("not_found", `no file at ${path}`));
      else print(json ? JSON.stringify({ path, deleted: true }) : path);
    }
  },
  snapshot: async (api: Api, [first = "", second = ""]: string[]) => {
    if (first === "ls") {
      for (const snapshot of await api.snapshots()) {
        print(
          json
            ? JSON.stringify(snapshot)
            : [snapshot.name, snapshot.prefix || "-", snapshot.files, formatBytes(snapshot.bytes), snapshot.createdAt].join("\t"),
        );
      }
      return;
    }
    if (first === "rm") {
      if (second === "") throw new UsageError("use: agentfs snapshot rm <name>");
      await api.removeSnapshot(second);
      print(json ? JSON.stringify({ name: second, deleted: true }) : second);
      return;
    }
    const created = await api.snapshot(first, folder(second));
    print(
      json
        ? JSON.stringify(created)
        : `${created.name}: ${created.files} files, ${formatBytes(created.bytes)} from ${created.prefix || "everything"}`,
    );
  },
  restore: async (api: Api, [name = ""]: string[]) => {
    const snapshot = await snapshotNamed(api, name);
    await confirm(`this makes ${folder(values.to) || "everything"} exactly like snapshot ${snapshot}, deleting other files there`);
    const restored = await api.restore(snapshot, folder(values.to));
    print(
      json
        ? JSON.stringify(restored)
        : `${restored.name}: ${restored.restored} files restored, ${restored.deleted} deleted in ${restored.to || "everything"}`,
    );
  },
  diff: async (api: Api, [from = "", to]: string[]) => {
    const { added, changed, removed } = await api.diff(
      await snapshotNamed(api, from),
      to === undefined ? undefined : await snapshotNamed(api, to),
    );
    const changes = [
      ...added.map((change) => ({ status: "added", ...change })),
      ...changed.map((change) => ({ status: "changed", ...change })),
      ...removed.map((change) => ({ status: "removed", ...change })),
    ];
    for (const change of changes) print(json ? JSON.stringify(change) : `${change.status}\t${change.path}`);
  },
  timeline: async (api: Api, [path = ""]: string[]) => {
    const filter = { path, agent: values.by, session: values.session, op: values.op };
    for await (const event of values.follow ? api.follow(filter) : api.events(filter)) printEvent(event);
  },
  kv: async (api: Api, [action = "", key = "", raw = ""]: string[]) => {
    if (action === "ls") {
      for (const item of await api.kvList(key)) {
        print(json ? JSON.stringify(item) : `${item.key}\tv${item.version}\t${JSON.stringify(item.value)}`);
      }
      return;
    }
    if (key === "" || !["get", "set", "rm"].includes(action)) {
      throw new UsageError("use: agentfs kv get|set|rm|ls");
    }
    if (action === "get") {
      const item = await api.kvGet(key);
      print(json ? JSON.stringify(item) : JSON.stringify(item.value));
    } else if (action === "rm") {
      const guard = kvGuard();
      if (guard.kind === "none") await confirm(`this deletes kv key ${key}`);
      await api.kvRemove(key, guard);
      print(json ? JSON.stringify({ key, deleted: true }) : key);
    } else {
      if (raw === "") throw new UsageError("use: agentfs kv set <key> <json or ->");
      const value = asJson(raw === "-" ? await readStdin() : raw);
      const item = await api.kvSet(key, value, { precondition: kvGuard(), ttlSeconds: ttlOf() });
      print(json ? JSON.stringify(item) : `${item.key}\tv${item.version}`);
    }
  },
  log: async (api: Api, [name = ""]: string[]) => {
    if (values.status !== "ok" && values.status !== "error") throw new UsageError("use --status ok or --status error");
    const durationMs = whole(values.duration, "--duration");
    const event = await api.logEvent({
      name,
      ...(values.input === undefined ? {} : { input: asJson(values.input) }),
      ...(values.output === undefined ? {} : { output: asJson(values.output) }),
      status: values.status,
      durationMs,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
    });
    print(json ? JSON.stringify(event) : event.id);
  },
  import: async (api: Api, [file = ""]: string[]) => {
    const summary = await importDatabase(api, file, {
      to: values.to === "" ? basename(file, extname(file)) : values.to,
      includeSecrets: values["include-secrets"],
      force: values.force,
    });
    for (const note of summary.skipped) process.stderr.write(`skipped: ${note}\n`);
    for (const problem of summary.problems) process.stderr.write(`error: ${problem}\n`);
    if (summary.problems.length > 0) process.exitCode = 1;
    if (json) return print(JSON.stringify(summary));
    print(`files       ${summary.files} (${formatBytes(summary.bytes)})`);
    print(`kv entries  ${summary.kv}`);
    print(`tool calls  ${summary.toolCalls}`);
    print(`skipped     ${summary.skipped.length}`);
  },
  export: async (api: Api, [path = "", file = ""]: string[]) => {
    const summary = await exportDatabase(api, path, file);
    print(
      json
        ? JSON.stringify({ ...summary, file })
        : `${summary.files} files (${formatBytes(summary.bytes)}) and ${summary.kv} kv entries written to ${file}`,
    );
  },
  undelete: async (api: Api, [path = ""]: string[]) => {
    const file = await api.undelete(path);
    print(json ? JSON.stringify(file) : linkOf(file));
  },
  sign: async (api: Api, [path = ""]: string[]) => {
    const link = await api.sign(path, ttlOf());
    print(json ? JSON.stringify(link) : link.url);
  },
  usage: async (api: Api) => {
    const by = values.by === "" ? "agent" : values.by;
    if (!USAGE_LABELS.includes(by)) throw new UsageError("use --by agent, session or commit");
    for (const row of (await api.usage(by)).rows) {
      print(
        json
          ? JSON.stringify(row)
          : [row.value ?? "-", row.files, formatBytes(row.bytes), `${row.writes} writes`].join("\t"),
      );
    }
  },
  run: async (api: Api, command: string[]) => {
    const started = performance.now();
    const ttlSeconds = ttlOf();
    const timeout = values.timeout === undefined ? undefined : parseDuration(values.timeout);
    const ins = (values.in ?? []).map(localFolder);
    const outs = (values.out ?? []).map(localFolder);
    const pulled: PullOutcome[] = [];
    for (const input of ins) {
      const outcomes = await pull(api, input, parentOf(input) || ".");
      const failed = outcomes.filter((outcome) => outcome.kind === "failed");
      for (const outcome of failed) process.stderr.write(`error: ${outcome.path}: ${outcome.reason}\n`);
      if (failed.length > 0) {
        process.exitCode = 1;
        return;
      }
      pulled.push(...outcomes);
    }
    const code = await exec(command, timeout);
    const pushed: PutOutcome[] = [];
    for (const output of outs) {
      pushed.push(
        ...(await upload(api, [output], parentOf(output), ttlSeconds).catch((error: Error) => {
          process.stderr.write(`error: ${error.message}\n`);
          process.exitCode = 1;
          return [];
        })),
      );
    }
    const exitCode = code !== 0 ? code : Number(process.exitCode ?? 0);
    const downloaded = pulled.flatMap((outcome) => (outcome.kind === "downloaded" ? [outcome.size] : []));
    const sent = pushed.flatMap((outcome) => (outcome.kind === "uploaded" ? [outcome.file.size] : []));
    const files = pushed.filter((outcome) => outcome.kind === "uploaded" || outcome.kind === "linked").length;
    const bytes = [...downloaded, ...sent].reduce((total, size) => total + size, 0);
    const seconds = (performance.now() - started) / 1000;
    if (json) {
      print(JSON.stringify({ event: "summary", exitCode, pulled: downloaded.length, pushed: files, bytes, seconds: Number(seconds.toFixed(2)) }));
    } else {
      process.stderr.write(
        `exit ${exitCode}, ${downloaded.length} files pulled, ${files} files pushed, ${formatBytes(bytes)} in ${seconds.toFixed(2)}s\n`,
      );
    }
    if (exitCode !== 0) process.exitCode = exitCode;
  },
  sync: async (api: Api, [dir = "", remote = ""]: string[]) => {
    setCommand("sync");
    const prefix = folder(remote);
    const pass = async () => {
      const started = performance.now();
      const changes = await syncOnce(api, dir, prefix);
      for (const change of changes) {
        if (json) {
          const { kind, ...rest } = change;
          print(JSON.stringify({ event: kind, ...rest }));
        } else if (change.kind === "failed") process.stderr.write(`error: ${change.path}: ${change.reason}\n`);
        else print(change.kind === "conflict" ? `conflict\t${change.path}\t${change.copy ?? "-"}` : `${change.kind}\t${change.path}`);
      }
      return syncSummary(started, changes);
    };
    if (!values.watch) {
      process.exitCode = await pass();
      return;
    }
    process.exit(await watchLoop(api, dir, prefix, () => pass().catch((error: Error) => failWith(error))));
  },
  fork: async (api: Api, [from = "", to = ""]: string[]) => {
    const forked = await api.fork(from, to);
    print(json ? JSON.stringify(forked) : `${forked.copied} files forked to ${forked.to}`);
  },
  limits: async (api: Api) => {
    const limits = values.cap === undefined ? await api.limits() : await api.setCap(parseBytes(values.cap));
    if (json) return print(JSON.stringify(limits));
    print(tierLine(limits));
    print(`used      ${formatBytes(limits.usedBytes)} of ${sizeOf(limits.capBytes)} (${limits.files} files)`);
    print(`owner     ${limits.owner === null ? `nobody yet; files expire ${limits.expiresAt ?? "24 hours after the first upload"} unless claimed (agentfs claim)` : limits.owner}`);
    print(`max cap   ${sizeOf(limits.maxCapBytes)} on the ${limits.plan} plan`);
    print(`max file  ${formatBytes(limits.maxFileBytes)} on the ${limits.plan} plan`);
    print(`parallel  ${limits.parallelUploads} uploads, ${limits.maxBatchFiles} files per batch`);
  },
  claim: async (api: Api) => {
    const link = await api.claim();
    const { expiresAt: deleteAt } = await api.limits();
    const message =
      link.message ??
      `Give your person this link:\n${link.url}\nThey sign in with GitHub or Google to keep these files. The link works until ${link.expiresAt}. Files nobody has claimed are deleted ${deleteAt === null ? "24 hours after the first upload" : `at ${deleteAt}`}.`;
    if (json) return print(JSON.stringify({ ...link, message }));
    print(link.url);
    process.stderr.write(`${message}\n`);
  },
  key: async (api: Api, [action = "", id = ""]: string[]) => {
    if (action === "list") {
      for (const key of await api.listKeys()) {
        print(
          json
            ? JSON.stringify(key)
            : [key.id, key.prefix || "-", key.permissions.join(","), key.expiresAt ?? "never", key.createdAt, `...${key.last4}`, key.revoked ? "revoked" : "active"].join("\t"),
        );
      }
      return;
    }
    if (action === "revoke") {
      if (id === "") throw new UsageError("use: agentfs key revoke <id>");
      await api.revokeKey(id);
      print(json ? JSON.stringify({ id, revoked: true }) : id);
      return;
    }
    if (action === "create") {
      const permissions = PERMISSIONS.filter((permission) => values[permission]);
      if (permissions.length === 0) throw new UsageError("use at least one of --read, --write, --delete");
      const created = await api.createKey(folder(values.prefix), permissions, ttlOf());
      print(json ? JSON.stringify(created) : created.key);
      return;
    }
    if (action !== "rotate") throw new UsageError("use: agentfs key create|list|revoke|rotate");
    const key = await api.rotateKey();
    if (api.source === "file") {
      await saveKey(key);
      print(json ? JSON.stringify({ rotated: true, saved: true, file: keyFile }) : `rotated; the new key is in ${keyFile}`);
    } else {
      print(json ? JSON.stringify({ rotated: true, saved: false, key }) : key);
      process.stderr.write("rotated; AGENTFS_KEY still holds the old key, so set it to the key above.\n");
    }
  },
  mcp: async (api: Api) => {
    const used = await mcpKey(api);
    const config = { mcpServers: { agentfs: { type: "http", url: `${baseUrl()}/mcp`, headers: { Authorization: `Bearer ${used.key}` } } } };
    print(JSON.stringify(config, null, 2));
    process.stderr.write(`key: ${used.about}\n`);
  },
  feedback: async (api: Api, words: string[]) => {
    await api.feedback(words.join(" "));
    print(json ? JSON.stringify({ sent: true }) : "sent");
  },
};

const keyless = {
  status: async () => {
    const found = await findKey();
    if (values.check) {
      if (found === null) process.exitCode = 1;
      else await (await connect()).limits().catch(() => { process.exitCode = 1; });
      return;
    }
    if (found === null) {
      print(json ? JSON.stringify({ key: null }) : "key       none; any command signs up, or run agentfs login --key-stdin");
      return;
    }
    const api = await connect();
    const limits = await api.limits();
    const { key } = limits;
    const scope = key.scoped ? "scoped" : "full";
    const where = found.source === "env" ? "AGENTFS_KEY" : keyFile;
    if (json) {
      print(JSON.stringify({ key: where, account: api.account, claimed: limits.owner !== null, owner: limits.owner, expiresAt: limits.expiresAt, keyId: key.id, keyExpiresAt: key.expiresAt, prefix: key.prefix, permissions: key.permissions, plan: limits.plan, tier: limits.tier, ownerUsedBytes: limits.ownerUsedBytes, ownerLimitBytes: limits.ownerLimitBytes, usedBytes: limits.usedBytes, capBytes: limits.capBytes, files: limits.files, scope }));
      return;
    }
    print(`key       ${found.source === "env" ? "from AGENTFS_KEY" : `saved in ${keyFile}`}`);
    print(
      `account   ${api.account} (${key.scoped ? `scoped key: ${key.prefix || "everything"}, ${key.permissions.join(",")}` : "full key"})`,
    );
    if (key.expiresAt !== null) print(`key ends  ${key.expiresAt}`);
    print(`owner     ${limits.owner === null ? "nobody yet; run agentfs claim to keep these files" : limits.owner}`);
    print(`expires   ${limits.expiresAt ?? "never"}`);
    print(`used      ${formatBytes(limits.usedBytes)} of ${sizeOf(limits.capBytes)} (${limits.files} files)`);
    print(tierLine(limits));
  },
  login: async () => {
    if (!values["key-stdin"]) throw new UsageError("use: agentfs login --key-stdin, with the key piped in");
    const key = (await readStdin()).trim();
    if (key === "") throw new UsageError("no key on stdin");
    const api = await connect({ key, source: "file" });
    await api.limits();
    await saveKey(key);
    print(json ? JSON.stringify({ account: api.account, key: keyFile }) : `logged in as ${api.account}; the key is in ${keyFile}`);
  },
  logout: async () => {
    await rm(keyFile, { force: true });
    if (process.env.AGENTFS_KEY !== undefined && process.env.AGENTFS_KEY !== "") {
      process.stderr.write("AGENTFS_KEY is still set in this shell.\n");
    }
    print(json ? JSON.stringify({ loggedOut: true }) : "logged out");
  },
  report: async ([url = "", ...reason]: string[]) => {
    const received = await report(url, reason.join(" "));
    print(json ? JSON.stringify(received) : "received");
  },
};

const isCommand = (name: string): name is keyof typeof commands => name in commands;
const isKeyless = (name: string): name is keyof typeof keyless => name in keyless;

const run = async ([name = "", ...args]: string[]) => {
  if (values.version) return print(version);
  const known = isCommand(name) || isKeyless(name);
  if (values.help && known) {
    process.stdout.write(`${usageFor(name).join("\n")}\n`);
    return;
  }
  if (values.help || name === "") {
    process.stdout.write(USAGE);
    return;
  }
  if (!known) throw new UsageError(RENAMED.get(name) ?? `unknown command "${name}". Run agentfs --help.`);
  if (args.length < (MIN_ARGS.get(name) ?? 0)) {
    throw new UsageError(`agentfs ${name} needs more arguments:\n${usageFor(name).join("\n")}`);
  }
  if (isKeyless(name)) await keyless[name](args);
  else await commands[name](await connect(), args);
};

await run(positionals).catch((error: Error) => {
  process.exitCode = failWith(error);
});
