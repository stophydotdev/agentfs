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
import { bold, dim, dot, fail, header, ok, spinner } from "./ui";
import { joinPath, projectOf, uploadFile } from "./upload";

type Options = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL: Options = {
  "api-key": { type: "string", short: "k" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
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

type Command = {
  summary: string;
  usage: string;
  options?: Options;
  auth?: boolean;
  run: (context: Context) => Promise<void>;
};

class UsageError extends Error {}

const text = (flags: Flags, name: string) => {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
};

const say = (line = "") => process.stderr.write(`${line}\n`);

const saveKey = (apiKey: string, apiUrl: string) =>
  writeConfig({ ...readConfig(), apiKey, apiUrl: apiUrl === DEFAULT_API_URL ? undefined : apiUrl });

const COMMANDS: Record<string, Command> = {
  login: {
    summary: "Log in with your browser, or save an API key",
    usage: "agentfs login [--api-key afs_...] [--no-browser]",
    options: { "no-browser": { type: "boolean" } },
    async run({ flags, client, out, apiUrl }) {
      if (!out.json) say(header());
      const given = text(flags, "api-key");
      if (given) {
        const check = spinner("Checking the key");
        const account = await createClient({ apiKey: given, apiUrl }).me().catch(() => undefined);
        if (!account?.authenticated) {
          check.fail("That API key was not accepted");
          throw new Error("That API key was not accepted.");
        }
        check.succeed("Key accepted");
        saveKey(given, apiUrl);
        out.data({ success: true, default_project: account.default_project }, () => `${ok("Login successful!")}\n  ${dim(`Saved to ${configPath()}`)}`);
        return;
      }
      const device = await client.startDevice();
      const opened = !flags["no-browser"] && openBrowser(device.verification_uri_complete);
      say(opened ? "Opening browser for authentication..." : "Open this link to log in:");
      say(`${opened ? dim("If the browser doesn't open, visit: ") : "  "}${device.verification_uri_complete}`);
      say(`${dim("Code:")} ${bold(device.user_code)}`);
      say();
      const wait = spinner("Waiting for browser authentication...");
      const token = await waitForApproval(client, device).catch((error: unknown) => {
        wait.fail("Login did not finish");
        throw error;
      });
      wait.stop();
      saveKey(token.api_key, apiUrl);
      out.data({ success: true, default_project: token.default_project }, () =>
        [ok("Login successful!"), `  ${dim("Default project:")} ${token.default_project ?? "default"}`, "", `  Next: ${bold("agentfs setup")} ${dim("to give your agents AgentFS")}`].join("\n"),
      );
    },
  },
  logout: {
    summary: "Remove the saved API key",
    usage: "agentfs logout",
    async run({ out }) {
      const had = clearConfig();
      out.data({ success: true, removed: had }, () => (had ? ok("Logged out") : dim("You were not logged in.")));
    },
  },
  status: {
    summary: "Show the version, login and account",
    usage: "agentfs status",
    async run({ flags, client, out, apiUrl }) {
      const credentials = resolveCredentials({ apiKey: text(flags, "api-key") });
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
      const source = { flag: "via --api-key", env: "via AGENTFS_KEY", config: "via stored credentials", none: "" }[credentials.source];
      out.data(value, () =>
        [
          header().trimEnd(),
          "",
          value.authenticated
            ? `  ${dot(true, "Authenticated")} ${dim(source)}`
            : `  ${dot(false, value.key ? "Key not accepted" : "Not authenticated")} ${dim(value.key ? source : "run agentfs login")}`,
          ...(value.authenticated
            ? [`  ${dim("Plan:")} ${value.plan}`, `  ${dim("Default project:")} ${value.default_project}`, `  ${dim("Key:")} ${value.key}`]
            : []),
          ...(apiUrl === DEFAULT_API_URL ? [] : [`  ${dim("API:")} ${apiUrl}`]),
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
        const name = basename(local);
        const progress = spinner(`Uploading ${name}`);
        try {
          results.push(
            await uploadFile(
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
              (done) => progress.update(`Uploading ${name} ${dim(formatBytes(done))}`),
            ),
          );
          progress.stop();
        } catch (error) {
          progress.fail(`${name} failed`);
          throw error;
        }
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
      out.data(page, () => `${filesTable(page.items)}${page.next_cursor ? `\n\n${dim(`More: agentfs ls --cursor ${page.next_cursor}`)}` : ""}`);
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
      const progress = spinner(`Downloading ${basename(target)}`);
      try {
        const response = await client.content(id);
        if (!response.body) throw new Error("The file has no content.");
        await pipeline(response.body, createWriteStream(target));
        progress.stop();
      } catch (error) {
        progress.fail(`${basename(target)} failed`);
        throw error;
      }
      out.data({ success: true, path: target }, () => ok(`Saved ${target}`));
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
        ok(`${flags.permanent ? "Deleted" : "Moved to the trash"}: ${args.join(", ")}`),
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
      out.data(link, () => `${link.url}${link.expires_at ? `\n${dim(`Expires ${link.expires_at}`)}` : ""}`);
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
        out.data(project, () => ok(`Created ${project.name}`));
      } else if (action === "rm") {
        await client.deleteProject(required(args, 1, "project name"));
        out.data({ success: true, deleted: name }, () => ok(`Deleted ${name}`));
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
      out.data({ file, outcomes }, () =>
        Object.entries(outcomes)
          .map(([name, outcome]) => (outcome.startsWith("skipped") ? fail(`${name} ${dim(outcome)}`) : ok(`${name} ${dim(`${outcome} in ${file}`)}`)))
          .join("\n"),
      );
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
      const mark = (outcome: string, label: string) =>
        outcome.startsWith("skipped") || outcome.startsWith("failed") || outcome === "not found"
          ? `  ${fail(`${label} ${dim(outcome)}`)}`
          : `  ${ok(`${label} ${dim(outcome)}`)}`;
      if (what !== "mcp") {
        for (const root of skillRoots({ global: flags.local !== true, cwd: process.cwd(), home: homedir() })) {
          for (const skill of SKILLS) {
            const outcome = applySkill(root, skill, remove);
            results[`skill ${root}`] = outcome;
            lines.push(mark(outcome, `Skill ${root.replace(homedir(), "~")}`));
          }
        }
      }
      if (what !== "skills") {
        if (!apiKey && !remove) {
          lines.push(`  ${fail(`MCP ${dim("skipped: log in first with agentfs login")}`)}`);
        } else {
          for (const target of mcpTargets(apiUrl, apiKey ?? "")) {
            const outcome = target.found() ? target.apply(remove) : "not found";
            results[`mcp ${target.name}`] = outcome;
            lines.push(mark(outcome, `MCP ${target.name}`));
          }
        }
      }
      if (!remove) lines.push("", `  ${dim("Restart your agents to load AgentFS.")}`);
      out.data({ success: true, results }, () => [header().trimEnd(), "", ...lines].join("\n"));
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
  if (command) return `${command.summary}\n\n${bold("Usage:")} ${command.usage}\n\n${dim("Also: --api-key, --json, --help")}`;
  const width = Math.max(...Object.keys(COMMANDS).map((key) => key.length));
  return [
    header("Cloud storage for AI agents. Upload a file, get a link."),
    `${bold("Usage:")} agentfs <command> [options]`,
    "",
    bold("Commands:"),
    ...Object.entries(COMMANDS).map(([key, command]) => `  ${key.padEnd(width)}  ${dim(command.summary)}`),
    "",
    bold("Options:"),
    `  -k, --api-key <key>  ${dim("API key (or set AGENTFS_KEY)")}`,
    `  --json               ${dim("JSON output (default when piped)")}`,
    `  --status             ${dim("Show login and account")}`,
    `  -h, --help           ${dim("Help for a command")}`,
    `  -V, --version        ${dim("Print the version")}`,
    "",
    `${dim("Start with:")} agentfs login ${dim("then")} agentfs setup`,
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
    process.stderr.write(`${fail(`Unknown command ${first}`)}\n${help()}\n`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...command.options }, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${fail(error instanceof Error ? error.message : String(error))}\n${dim(`Usage: ${command.usage}`)}\n`);
    return 1;
  }
  const flags: Flags = parsed.values;
  if (flags.help) {
    process.stdout.write(`${help(first)}\n`);
    return 0;
  }
  const out = createOutput(flags.json === true);
  const credentials = resolveCredentials({ apiKey: text(flags, "api-key") });
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
    else process.stderr.write(`${fail(message)}${error instanceof ApiError ? ` ${dim(`(${error.code})`)}` : ""}\n`);
    if (error instanceof UsageError && !out.json) process.stderr.write(`${dim(`Usage: ${command.usage}`)}\n`);
    return 1;
  }
}
