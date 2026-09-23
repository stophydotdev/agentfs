import { createWriteStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";

import pkg from "../package.json";
import { ApiError, createClient, type Client, type StoredFile } from "./api";
import { clearConfig, configPath, DEFAULT_API_URL, maskKey, readConfig, resolveCredentials, writeConfig } from "./config";
import { openBrowser, waitForApproval } from "./login";
import { createOutput, fileLine, filesTable, formatBytes, projectsTable, type Output } from "./output";
import { applySkill, mcpTargets, SKILLS, skillRoots, writeEnvKey } from "./setup";
import { joinPath, projectOf, uploadFile } from "./upload";

type Options = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL: Options = {
  "api-key": { type: "string", short: "k" },
  "api-url": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

type Command = {
  summary: string;
  usage: string;
  options?: Options;
  auth?: boolean;
  run: (context: Context) => Promise<void>;
};

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

type Context = {
  args: string[];
  flags: Flags;
  client: Client;
  out: Output;
  apiKey: string | undefined;
  apiUrl: string;
};

class UsageError extends Error {}

const text = (flags: Flags, name: string) => {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
};

const COMMANDS: Record<string, Command> = {
  login: {
    summary: "Log in with your browser, or save an API key",
    usage: "agentfs login [--api-key afs_...] [--no-browser]",
    options: { "no-browser": { type: "boolean" } },
    async run({ flags, client, out, apiUrl }) {
      const given = text(flags, "api-key");
      if (given) {
        const account = await createClient({ apiKey: given, apiUrl }).me();
        if (!account.authenticated) throw new Error("That API key was not accepted.");
        writeConfig({ ...readConfig(), apiKey: given, apiUrl: apiUrl === DEFAULT_API_URL ? undefined : apiUrl });
        out.data({ success: true, default_project: account.default_project }, () => `Logged in. Key saved to ${configPath()}`);
        return;
      }
      const device = await client.startDevice();
      const opened = !flags["no-browser"] && openBrowser(device.verification_uri_complete);
      process.stderr.write(
        `${opened ? "Opened your browser to approve this login." : "Open this link to approve this login:"}\n\n  ${device.verification_uri_complete}\n\n  Code: ${device.user_code}\n\nWaiting for approval...\n`,
      );
      const token = await waitForApproval(client, device);
      writeConfig({ ...readConfig(), apiKey: token.api_key, apiUrl: apiUrl === DEFAULT_API_URL ? undefined : apiUrl });
      out.data({ success: true, default_project: token.default_project }, () => `Logged in. Files go to the ${token.default_project ?? "default"} project unless you pass --project.`);
    },
  },
  logout: {
    summary: "Remove the saved API key",
    usage: "agentfs logout",
    async run({ out }) {
      const had = clearConfig();
      out.data({ success: true, removed: had }, () => (had ? "Logged out." : "You were not logged in."));
    },
  },
  status: {
    summary: "Show the version, login and account",
    usage: "agentfs status",
    async run({ flags, client, out, apiUrl }) {
      const credentials = resolveCredentials({ apiKey: text(flags, "api-key"), apiUrl: text(flags, "api-url") });
      const account = credentials.apiKey ? await client.me().catch(() => undefined) : undefined;
      const value = {
        version: pkg.version,
        api_url: apiUrl,
        authenticated: account?.authenticated ?? false,
        key: credentials.apiKey ? maskKey(credentials.apiKey) : null,
        key_source: credentials.source,
        plan: account?.plan ?? null,
        default_project: account?.default_project ?? null,
      };
      out.data(value, () =>
        [
          `agentfs ${value.version}`,
          `API       ${value.api_url}`,
          value.key
            ? `Key       ${value.key} (from ${value.key_source})${value.authenticated ? "" : "  NOT ACCEPTED"}`
            : "Key       none. Run agentfs login",
          ...(value.authenticated ? [`Plan      ${value.plan}`, `Project   ${value.default_project} (default)`] : []),
        ].join("\n"),
      );
    },
  },
  upload: {
    summary: "Upload files and print their links",
    usage: "agentfs upload <file...> [--project p] [--path p/name.ext | --prefix dir] [--visibility public|unlisted|private] [--expires-in 7d] [--label text] [--replace] [--run-id id] [--agent-id name]",
    auth: true,
    options: {
      project: { type: "string", short: "p" },
      path: { type: "string" },
      prefix: { type: "string" },
      visibility: { type: "string" },
      "expires-in": { type: "string" },
      label: { type: "string" },
      replace: { type: "boolean" },
      "run-id": { type: "string" },
      "agent-id": { type: "string" },
    },
    async run({ args, flags, client, out }) {
      if (args.length === 0) throw new UsageError("Pass at least one file.");
      if (args.length > 1 && text(flags, "path")) throw new UsageError("--path names one file. Use --prefix for several.");
      const missing = args.filter((file) => !existsSync(file));
      if (missing.length > 0) throw new UsageError(`No such file: ${missing.join(", ")}`);
      const results: StoredFile[] = [];
      for (const local of args) {
        const file = await uploadFile(
          client,
          local,
          {
            project: text(flags, "project"),
            path: text(flags, "path"),
            prefix: text(flags, "prefix"),
            visibility: text(flags, "visibility"),
            expiresIn: text(flags, "expires-in"),
            label: text(flags, "label"),
            replace: flags.replace === true,
            runId: text(flags, "run-id") ?? process.env.AGENTFS_RUN_ID,
            agentId: text(flags, "agent-id") ?? process.env.AGENTFS_AGENT_ID,
          },
          (done) => out.info(`${basename(local)}: ${formatBytes(done)} sent`),
        );
        results.push(file);
      }
      out.data(args.length === 1 ? results[0] : { success: true, files: results }, () => results.map(fileLine).join("\n\n"));
    },
  },
  ls: {
    summary: "List files",
    usage: "agentfs ls [--project p] [--prefix dir] [--path p/name] [--query text] [--run-id id] [--limit n] [--cursor c]",
    auth: true,
    options: {
      project: { type: "string", short: "p" },
      prefix: { type: "string" },
      path: { type: "string" },
      query: { type: "string", short: "q" },
      "run-id": { type: "string" },
      limit: { type: "string", short: "n" },
      cursor: { type: "string" },
    },
    async run({ flags, client, out }) {
      const prefix = text(flags, "prefix");
      const path = text(flags, "path");
      const project = prefix || path ? await projectOf(client, text(flags, "project")) : text(flags, "project");
      const page = await client.listFiles({
        project,
        prefix: prefix ? joinPath(project, prefix) : undefined,
        path: path ? joinPath(project, path) : undefined,
        q: text(flags, "query"),
        run_id: text(flags, "run-id"),
        limit: text(flags, "limit") ? Number(text(flags, "limit")) : undefined,
        cursor: text(flags, "cursor"),
      });
      out.data(page, () => `${filesTable(page.items)}${page.next_cursor ? `\n\nMore: agentfs ls --cursor ${page.next_cursor}` : ""}`);
    },
  },
  get: {
    summary: "Show one file",
    usage: "agentfs get <file-id>",
    auth: true,
    async run({ args, client, out }) {
      const file = await client.getFile(required(args, 0, "file id"));
      out.data(file, () => fileLine(file));
    },
  },
  download: {
    summary: "Download a file",
    usage: "agentfs download <file-id> [-o path]",
    auth: true,
    options: { output: { type: "string", short: "o" } },
    async run({ args, flags, client, out }) {
      const id = required(args, 0, "file id");
      const target = resolve(text(flags, "output") ?? (await client.getFile(id)).name);
      const response = await client.content(id);
      if (!response.body) throw new Error("The file has no content.");
      await pipeline(response.body, createWriteStream(target));
      out.data({ success: true, path: target }, () => `Saved ${target}`);
    },
  },
  mv: {
    summary: "Rename a file (its id and link stay the same)",
    usage: "agentfs mv <file-id> <new-name>",
    auth: true,
    async run({ args, client, out }) {
      const file = await client.renameFile(required(args, 0, "file id"), required(args, 1, "new name"));
      out.data(file, () => fileLine(file));
    },
  },
  rm: {
    summary: "Move files to the trash, or delete them for good",
    usage: "agentfs rm <file-id...> [--permanent]",
    auth: true,
    options: { permanent: { type: "boolean" } },
    async run({ args, flags, client, out }) {
      if (args.length === 0) throw new UsageError("Pass at least one file id.");
      for (const id of args) await client.deleteFile(id, flags.permanent === true);
      out.data({ success: true, deleted: args, permanent: flags.permanent === true }, () =>
        `${flags.permanent ? "Deleted" : "Moved to the trash"}: ${args.join(", ")}`,
      );
    },
  },
  share: {
    summary: "Create a time-limited link for a private file",
    usage: "agentfs share <file-id> [--expires-in 1h]",
    auth: true,
    options: { "expires-in": { type: "string" } },
    async run({ args, flags, client, out }) {
      const link = await client.accessUrl(required(args, 0, "file id"), text(flags, "expires-in"));
      out.data(link, () => `${link.url}${link.expires_at ? `\nExpires ${link.expires_at}` : ""}`);
    },
  },
  projects: {
    summary: "List, create or delete projects",
    usage: "agentfs projects [create <name> | rm <name>]",
    auth: true,
    async run({ args, client, out }) {
      const [action, name] = args;
      if (action === "create") {
        const project = await client.createProject(required(args, 1, "project name"));
        out.data(project, () => `Created ${project.name}`);
      } else if (action === "rm") {
        await client.deleteProject(required(args, 1, "project name"));
        out.data({ success: true, deleted: name }, () => `Deleted ${name}`);
      } else if (action === undefined || action === "ls") {
        const { items } = await client.listProjects();
        out.data({ items }, () => projectsTable(items));
      } else {
        throw new UsageError(`Unknown projects action ${action}.`);
      }
    },
  },
  env: {
    summary: "Write AGENTFS_KEY into a .env file",
    usage: "agentfs env [--file .env] [--overwrite]",
    auth: true,
    options: { file: { type: "string", short: "f" }, overwrite: { type: "boolean" } },
    async run({ flags, out, apiKey, apiUrl }) {
      const file = resolve(text(flags, "file") ?? ".env");
      const values: Record<string, string> = { AGENTFS_KEY: apiKey ?? "" };
      if (apiUrl !== DEFAULT_API_URL) values.AGENTFS_API_URL = apiUrl;
      const outcomes = writeEnvKey(file, values, flags.overwrite === true);
      out.data({ file, outcomes }, () => Object.entries(outcomes).map(([name, outcome]) => `${name.padEnd(16)} ${outcome}`).join("\n"));
    },
  },
  setup: {
    summary: "Install the agentfs skill and hosted MCP server into your agents",
    usage: "agentfs setup [skills|mcp] [--local] [--remove]",
    options: { local: { type: "boolean" }, remove: { type: "boolean" } },
    async run({ args, flags, out, apiKey, apiUrl }) {
      const what = args[0] ?? "all";
      if (!["all", "skills", "mcp"].includes(what)) throw new UsageError(`Unknown setup target ${what}. Use skills or mcp.`);
      const remove = flags.remove === true;
      const lines: string[] = [];
      const results: Record<string, string> = {};
      if (what !== "mcp") {
        for (const root of skillRoots({ global: flags.local !== true, cwd: process.cwd(), home: homedir() })) {
          for (const skill of SKILLS) {
            const outcome = applySkill(root, skill, remove);
            results[`skill ${root}`] = outcome;
            lines.push(`skill        ${root.replace(homedir(), "~")}  ${outcome}`);
          }
        }
      }
      if (what !== "skills") {
        if (!apiKey && !remove) {
          lines.push("mcp          skipped: log in first with agentfs login");
        } else {
          for (const target of mcpTargets(apiUrl, apiKey ?? "")) {
            const outcome = target.found() ? target.apply(remove) : "not found";
            results[`mcp ${target.name}`] = outcome;
            lines.push(`mcp          ${target.name.padEnd(12)} ${outcome}`);
          }
        }
      }
      if (!remove) lines.push("", "Restart your agents to load agentfs.");
      out.data({ success: true, results }, () => lines.join("\n"));
    },
  },
};

function required(args: string[], index: number, name: string) {
  const value = args[index];
  if (!value) throw new UsageError(`Missing ${name}.`);
  return value;
}

function help(name?: string) {
  const command = name ? COMMANDS[name] : undefined;
  if (command) return `${command.summary}\n\nUsage: ${command.usage}\n\nGlobal: --api-key, --api-url, --json`;
  const width = Math.max(...Object.keys(COMMANDS).map((key) => key.length));
  return [
    `agentfs ${pkg.version} - cloud storage for AI agents. Upload a file, get a link.`,
    "",
    "Usage: agentfs <command> [options]",
    "",
    ...Object.entries(COMMANDS).map(([key, command]) => `  ${key.padEnd(width)}  ${command.summary}`),
    "",
    "Global options:",
    "  -k, --api-key <key>  API key (or AGENTFS_KEY)",
    "  --api-url <url>      API origin (or AGENTFS_API_URL), default https://agentfs.cloud",
    "  --json               JSON output (default when piped)",
    "  -h, --help           Help for a command",
    "  -V, --version        Print the version",
    "",
    "Start with: agentfs login, then agentfs setup",
  ].join("\n");
}

export async function main(argv: string[]) {
  const [first, ...rest] = argv;
  if (first === "-V" || first === "--version" || first === "version") {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (first === "--status") return main(["status", ...rest]);
  if (!first || first === "-h" || first === "--help" || first === "help") {
    process.stdout.write(`${help(rest[0])}\n`);
    return 0;
  }
  const command = COMMANDS[first];
  if (!command) {
    process.stderr.write(`Unknown command ${first}.\n\n${help()}\n`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...command.options }, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\nUsage: ${command.usage}\n`);
    return 1;
  }
  const flags: Flags = parsed.values;
  if (flags.help) {
    process.stdout.write(`${help(first)}\n`);
    return 0;
  }
  const out = createOutput(flags.json === true);
  const credentials = resolveCredentials({ apiKey: text(flags, "api-key"), apiUrl: text(flags, "api-url") });
  try {
    if (command.auth && !credentials.apiKey) throw new UsageError("Not logged in. Run agentfs login, or set AGENTFS_KEY.");
    await command.run({
      args: parsed.positionals,
      flags,
      client: createClient(credentials),
      out,
      apiKey: credentials.apiKey,
      apiUrl: credentials.apiUrl,
    });
    return 0;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : error instanceof UsageError ? "usage" : "error";
    const message = error instanceof Error ? error.message : String(error);
    if (out.json) process.stdout.write(`${JSON.stringify({ success: false, error: { code, message } }, null, 2)}\n`);
    else process.stderr.write(`Error: ${message}${error instanceof ApiError ? ` (${error.code})` : ""}\n`);
    if (error instanceof UsageError && !out.json) process.stderr.write(`Usage: ${command.usage}\n`);
    return 1;
  }
}
