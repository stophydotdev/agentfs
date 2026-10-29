import { parseArgs } from "node:util";
import { version } from "../package.json";
import { type Api, ApiError, base, connect, keyFile, saveKey } from "./api";
import { pull } from "./pull";
import { put } from "./put";
import { formatBytes, parseBytes } from "./units";

const USAGE = `agentfs ${version}: upload files and get links

  agentfs put <file or folder>... [--to folder]  upload; unchanged and known bytes are not sent
  agentfs pull <folder> [into]                   download; unchanged files are skipped
  agentfs ls [prefix] [--by agent]               list files
  agentfs rm <path>...                           delete files
  agentfs fork <folder> <new folder>             copy a folder without sending any bytes
  agentfs limits [--cap 5GB]                     show usage and limits, or set a storage cap
  agentfs claim                                  get a link for your person to keep these files
  agentfs key rotate                             replace your key; the old one stops working
  agentfs mcp                                    print the MCP config for agents without a shell
  agentfs feedback <message>                     tell the agentfs team what slows you down

Add --json for one JSON object per line. In a git repo, put skips what .gitignore ignores.
Files that look like secrets (.env, keys) are skipped unless you add --include-secrets.
`;

const MIN_ARGS = new Map([
  ["put", 1],
  ["pull", 1],
  ["ls", 0],
  ["rm", 1],
  ["fork", 2],
  ["limits", 0],
  ["claim", 0],
  ["key", 1],
  ["mcp", 0],
  ["feedback", 1],
]);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: "string", default: "" },
    by: { type: "string", default: "" },
    cap: { type: "string" },
    json: { type: "boolean", default: false },
    "include-secrets": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
});

const print = (line: string) => process.stdout.write(`${line}\n`);

process.stdout.on("error", (error) => {
  if ("code" in error && error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

const OUTCOME_ORDER = ["uploaded", "linked", "downloaded", "unchanged", "failed"];

const summarize = (started: number, outcomes: { kind: string }[]) => {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
  const parts = OUTCOME_ORDER.filter((kind) => counts.has(kind)).map(
    (kind) => `${counts.get(kind)} ${kind}`,
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  process.stderr.write(`${parts.join(", ") || "nothing to do"} in ${seconds}s\n`);
  if (counts.has("failed")) process.exitCode = 1;
};

const commands = {
  put: async (api: Api, args: string[]) => {
    const started = performance.now();
    const { outcomes, skipped } = await put(api, args, values.to, values["include-secrets"]);
    if (skipped.length > 0) {
      process.stderr.write(
        `skipped ${skipped.length} files that look like secrets: ${skipped.join(", ")}. Add --include-secrets to upload them.\n`,
      );
    }
    for (const outcome of outcomes) {
      if (outcome.kind === "failed") process.stderr.write(`error: ${outcome.path}: ${outcome.reason}\n`);
      else print(values.json ? JSON.stringify({ ...outcome.file, status: outcome.kind }) : outcome.file.url);
    }
    summarize(started, outcomes);
  },
  pull: async (api: Api, [folder = "", into = "."]: string[]) => {
    const started = performance.now();
    const outcomes = await pull(api, folder, into);
    for (const outcome of outcomes) {
      if (outcome.kind === "failed") process.stderr.write(`error: ${outcome.path}: ${outcome.reason}\n`);
      else print(values.json ? JSON.stringify(outcome) : outcome.target);
    }
    summarize(started, outcomes);
  },
  ls: async (api: Api, [prefix = ""]: string[]) => {
    for (const file of await api.list(prefix)) {
      if (values.by !== "" && file.agent !== values.by) continue;
      const by = [file.agent ?? "-", file.commit ?? "-"].join("\t");
      print(values.json ? JSON.stringify(file) : `${file.path}\t${formatBytes(file.size)}\t${by}\t${file.url}`);
    }
  },
  rm: async (api: Api, paths: string[]) => {
    for (const path of paths) {
      await api.remove(path);
      print(path);
    }
  },
  fork: async (api: Api, [from = "", to = ""]: string[]) => {
    const forked = await api.fork(from, to);
    print(values.json ? JSON.stringify(forked) : `${forked.copied} files forked to ${forked.to}`);
  },
  limits: async (api: Api) => {
    const limits = values.cap === undefined ? await api.limits() : await api.setCap(parseBytes(values.cap));
    if (values.json) return print(JSON.stringify(limits));
    print(`used      ${formatBytes(limits.usedBytes)} of ${formatBytes(limits.capBytes)} (${limits.files} files)`);
    print(`owner     ${limits.owner === null ? `nobody yet; files expire ${limits.expiresAt ?? "24 hours after the first upload"} unless claimed (agentfs claim)` : `@${limits.owner}`}`);
    print(`max cap   ${formatBytes(limits.maxCapBytes)} on the ${limits.plan} plan`);
    print(`max file  ${formatBytes(limits.maxFileBytes)} in one request, ${formatBytes(limits.maxMultipartBytes)} in parts`);
    print(`parallel  ${limits.parallelUploads} uploads, ${limits.maxBatchFiles} files per batch`);
  },
  claim: async (api: Api) => {
    const link = await api.claim();
    if (values.json) return print(JSON.stringify(link));
    print(link.url);
    process.stderr.write(`Give this link to your person. They sign in with GitHub and the files are kept. It works until ${link.expiresAt}.\n`);
  },
  key: async (api: Api, [action = ""]: string[]) => {
    if (action !== "rotate") throw new Error("use: agentfs key rotate");
    const key = await api.rotateKey();
    if (api.source === "file") {
      await saveKey(key);
      print(`rotated; the new key is in ${keyFile}`);
    } else {
      print(key);
      process.stderr.write("rotated; AGENTFS_KEY still holds the old key, so set it to the key above.\n");
    }
  },
  mcp: async (api: Api) => {
    const config = { mcpServers: { agentfs: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${api.key}` } } } };
    print(JSON.stringify(config, null, 2));
  },
  feedback: async (api: Api, words: string[]) => {
    await api.feedback(words.join(" "));
    print("sent");
  },
};

const isCommand = (name: string): name is keyof typeof commands => name in commands;

const run = async ([name = "", ...args]: string[]) => {
  if (values.version) return print(version);
  if (values.help || !isCommand(name) || args.length < (MIN_ARGS.get(name) ?? 0)) {
    process.stdout.write(USAGE);
    if (!values.help && name !== "") process.exitCode = 1;
    return;
  }
  await commands[name](await connect(), args);
};

await run(positionals).catch((error: Error) => {
  process.stderr.write(`error: ${error.message}\n`);
  if (error instanceof ApiError && error.code === "key_revoked") {
    process.stderr.write(`If this account expired, delete ${keyFile} and run again to sign up.\n`);
  }
  process.exitCode = 1;
});
