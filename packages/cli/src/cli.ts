import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";

import pkg from "../package.json";
import { ApiError, createClient, type Client, type StoredFile } from "./api";
import { clearConfig, credentialsPath, DEFAULT_API_URL, insecureApiUrl, maskKey, permissions, readConfig, resolveCredentials, writeConfig } from "./config";
import { openBrowser, safeWebUrl, waitForApproval } from "./login";
import { createOutput, fileLine, filesTable, formatBytes, projectsTable, type Output } from "./output";
import { applySkill, mcpCopies, mcpTargets, SKILLS, skillRoots, skillsCli } from "./setup";
import { bold, clean, dim, dot, fail, header, ok, spinner } from "./ui";
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
  run: (context: Context) => Promise<number | void>;
};

class UsageError extends Error {}

const errorInfo = (error: unknown) => ({
  code: error instanceof ApiError ? error.code : error instanceof UsageError ? "usage" : "error",
  message: error instanceof Error ? error.message : String(error),
});

const text = (flags: Flags, name: string) => {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
};

const say = (line = "") => process.stderr.write(`${line}\n`);

const saveKey = (apiKey: string, apiUrl: string) =>
  writeConfig({ ...readConfig(), apiKey, apiUrl: apiUrl === DEFAULT_API_URL ? undefined : apiUrl });

async function browserLogin(client: Client, apiUrl: string, noBrowser: boolean) {
  const device = await client.startDevice();
  const link = safeWebUrl(device.verification_uri_complete);
  if (!link) throw new Error("The server sent a login link that is not a web address.");
  const opened = !noBrowser && openBrowser(link);
  say(opened ? "Opening browser for authentication..." : "Open this link to log in:");
  say(`${opened ? dim("If the browser doesn't open, visit: ") : "  "}${clean(link)}`);
  say(`${dim("Code:")} ${bold(clean(device.user_code))}`);
  say();
  const wait = spinner("Waiting for browser authentication...");
  const token = await waitForApproval(client, device).catch((error: unknown) => {
    wait.fail("Login did not finish");
    throw error;
  });
  wait.stop();
  saveKey(token.api_key, apiUrl);
  return token;
}

const POPULAR = ["/.claude/", "/.agents/", "/.codex/", "/.cursor/", "opencode/", "/.pi/"];

const byPopularity = (targets: string[]) => {
  const rank = (target: string) => {
    const index = POPULAR.findIndex((marker) => target.includes(marker));
    return index === -1 ? POPULAR.length : index;
  };
  return [...targets].sort((a, b) => rank(a) - rank(b));
};

type Integrations = { what: string; remove: boolean; local: boolean; apiKey: string | undefined; apiUrl: string };

function installIntegrations({ what, remove, local, apiKey, apiUrl }: Integrations) {
  const lines: string[] = [];
  const results: Record<string, string> = {};
  const mark = (outcome: string, label: string) =>
    outcome.startsWith("skipped") || outcome.startsWith("failed") || outcome === "not found"
      ? `  ${fail(`${label} ${dim(outcome)}`)}`
      : `  ${ok(`${label} ${dim(outcome)}`)}`;
  if (what !== "mcp") {
    const progress = spinner(remove ? "Removing the agentfs skill from your agents" : "Installing the agentfs skill for your agents");
    const viaCli = skillsCli({ remove, local, cwd: process.cwd() });
    progress.stop();
    if (viaCli.ok && (remove || viaCli.targets.length > 0)) {
      results.skills = remove ? "removed" : `installed: ${viaCli.targets.join(", ")}`;
      lines.push(
        remove
          ? `  ${ok("Skill removed from your agents")}`
          : `  ${ok(`Skill installed ${dim(`across ${viaCli.targets.length} agent folders`)}`)}`,
        ...byPopularity(viaCli.targets).slice(0, 4).map((target) => `    ${dim(target)}`),
        ...(viaCli.targets.length > 4 ? [`    ${dim(`+${viaCli.targets.length - 4} more, see agentfs setup skills --json`)}`] : []),
      );
    }
  }
  if (what !== "mcp" && results.skills === undefined) {
    for (const root of skillRoots({ global: !local, cwd: process.cwd(), home: homedir() })) {
      const outcomes = SKILLS.map((skill) => applySkill(root, skill, remove));
      SKILLS.forEach((skill, index) => {
        results[`skill ${join(root, skill)}`] = outcomes[index] ?? "";
      });
      const changed = outcomes.filter((outcome) => outcome !== "already set" && outcome !== "not set");
      const summary = changed.length === 0 ? (remove ? "not set" : "already set") : remove ? "removed" : "installed";
      lines.push(mark(summary, `${SKILLS.length === 1 ? "Skill" : `${SKILLS.length} skills`} ${dim(root.replace(homedir(), "~"))}`));
    }
  }
  if (what !== "skills") {
    if (!apiKey && !remove) {
      lines.push(`  ${fail(`MCP ${dim("skipped: log in first with agentfs login")}`)}`);
    } else {
      for (const target of mcpTargets(apiUrl, apiKey ?? "")) {
        const outcome = target.found() ? target.apply(remove) : "not found";
        results[`mcp ${target.name}`] = outcome;
        if (outcome !== "not found") lines.push(mark(outcome, `MCP ${target.name}`));
      }
    }
  }
  return { lines, results };
}

const onPath = () => spawnSync(process.platform === "win32" ? "where" : "which", ["agentfs"], { stdio: "ignore" }).status === 0;

const installedVersion = () => {
  const run = spawnSync("agentfs", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  return run.status === 0 ? run.stdout.trim() : undefined;
};

const COMMANDS: Record<string, Command> = {
  init: {
    summary: "Set up everything: install the CLI, log in, add the skill and MCP",
    usage: "agentfs init [--browser] [--api-key afs_...] [--local] [--skip-install] [--skip-auth] [--skip-skills]",
    options: {
      all: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      browser: { type: "boolean", short: "b" },
      local: { type: "boolean" },
      "no-browser": { type: "boolean" },
      "skip-install": { type: "boolean" },
      "skip-auth": { type: "boolean" },
      "skip-skills": { type: "boolean" },
    },
    async run({ flags, client, out, apiUrl }) {
      const steps = (["auth", "install", "skills"] as const).filter((step) => flags[`skip-${step}`] !== true);
      let current = 0;
      const step = (label: string) => say(`${bold(`[${++current}/${steps.length}]`)} ${label}`);
      const summary: Record<string, string> = {};
      say(header("Set up AgentFS for you and your agents"));

      let apiKey = resolveCredentials({ apiKey: text(flags, "api-key") }).apiKey;
      if (steps.includes("auth")) {
        const given = text(flags, "api-key");
        const account = apiKey ? await createClient({ apiKey, apiUrl }).me().catch(() => undefined) : undefined;
        if (given && !account?.authenticated) {
          step("Authenticating with API key...");
          say(`${fail("That API key was not accepted.")}\n`);
          summary.auth = "failed";
        } else if (given && account?.authenticated) {
          step("Authenticating with API key...");
          saveKey(given, apiUrl);
          say(`${ok("Authenticated")}\n`);
          summary.auth = "api_key";
        } else if (account?.authenticated) {
          step("Authenticating...");
          say(`${ok(`Already authenticated ${dim(`(${account.default_project ?? "default"} project)`)}`)}\n`);
          summary.auth = "existing";
        } else {
          step("Authenticating with AgentFS...");
          try {
            apiKey = (await browserLogin(client, apiUrl, flags["no-browser"] === true)).api_key;
            say(`${ok("Authenticated")}\n`);
            summary.auth = "browser";
          } catch (error) {
            say(`${fail(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`)}`);
            say(`${dim("You can log in later with: agentfs login")}\n`);
            summary.auth = "failed";
          }
        }
      }

      if (steps.includes("install")) {
        step("Installing agentfs globally...");
        if (onPath() && installedVersion() === pkg.version) {
          say(`${ok(`Already installed ${dim(`v${pkg.version}`)}`)}\n`);
          summary.install = "already set";
        } else {
          const install = spawnSync("npm", ["install", "-g", `${pkg.name}@${pkg.version}`], { stdio: "inherit", shell: process.platform === "win32" });
          if (install.status === 0) {
            say(`${ok("CLI installed globally")}\n`);
            summary.install = "installed";
            if (!onPath()) say(`${dim(`agentfs isn't on your PATH yet. Until then run it as: npx ${pkg.name} <command>`)}\n`);
          } else {
            say(`${fail("Could not install globally. You may need to fix npm permissions.")}`);
            say(`${dim(`Continuing. You can still run: npx ${pkg.name} <command>`)}\n`);
            summary.install = "failed";
          }
        }
      }

      if (steps.includes("skills")) {
        step("Installing the agentfs skill and MCP server for your AI agents...");
        const { lines, results } = installIntegrations({ what: "all", remove: false, local: flags.local === true, apiKey, apiUrl });
        say([...lines, ""].join("\n"));
        Object.assign(summary, results);
      }

      const arrow = dim("→");
      out.data({ success: summary.auth !== "failed", steps: summary }, () =>
        [
          `  ${ok(`AgentFS is ready ${dim("for you and your AI agents")}`)}`,
          "",
          `  ${dim("Try it here or ask your agent:")}`,
          `    ${arrow} ${bold("Upload")}   ${dim('"Save report.pdf and give me a link"')}      agentfs upload report.pdf`,
          `    ${arrow} ${bold("Private")}  ${dim('"Store data.csv privately, link for 1h"')}  agentfs upload data.csv --visibility private`,
          `    ${arrow} ${bold("Find")}     ${dim('"What did my last run save?"')}             agentfs ls --run-id <id>`,
          "",
          `  ${arrow} ${dim("All commands:")} ${bold("agentfs --help")}`,
          `  ${arrow} ${dim("Restart your agents to load AgentFS.")}`,
        ].join("\n"),
      );
    },
  },
  login: {
    summary: "Log in with your browser, or save an API key",
    usage: "agentfs login [--api-key afs_... | --api-key - (read from stdin)] [--no-browser]",
    options: { "no-browser": { type: "boolean" } },
    async run({ flags, client, out, apiUrl }) {
      if (!out.json) say(header());
      const given = text(flags, "api-key") === "-" ? await readStdin() : text(flags, "api-key");
      if (given) {
        const check = spinner("Checking the key");
        const account = await createClient({ apiKey: given, apiUrl }).me().catch(() => undefined);
        if (!account?.authenticated) {
          check.fail("That API key was not accepted");
          throw new Error("That API key was not accepted.");
        }
        check.succeed("Key accepted");
        saveKey(given, apiUrl);
        out.data({ success: true, default_project: account.default_project }, () => `${ok("Login successful!")}\n  ${dim(`Saved to ${credentialsPath()}`)}`);
        return;
      }
      const token = await browserLogin(client, apiUrl, flags["no-browser"] === true);
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
      const copies = mcpCopies();
      out.data({ success: true, removed: had, key_still_in: copies }, () =>
        [
          had ? ok("Logged out") : dim("You were not logged in."),
          ...(copies.length > 0
            ? ["", `  ${dim("Your agents still have a key in their MCP config:")}`, ...copies.map((copy) => `  ${dim("·")} ${copy.name} ${dim(copy.location)}`), `  ${dim("Remove it with:")} agentfs setup mcp --remove`]
            : []),
        ].join("\n"),
      );
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
            ? [`  ${dim("Plan:")} ${clean(value.plan ?? "")}`, `  ${dim("Default project:")} ${clean(value.default_project ?? "")}`, `  ${dim("Key:")} ${value.key}`]
            : []),
          ...(apiUrl === DEFAULT_API_URL ? [] : [`  ${dim("API:")} ${apiUrl}`]),
        ].join("\n"),
      );
    },
  },
  config: {
    summary: "Show where your credentials are stored and who can read them",
    usage: "agentfs config",
    async run({ flags, client, out, apiUrl }) {
      const credentials = resolveCredentials({ apiKey: text(flags, "api-key") });
      const account = credentials.apiKey ? await client.me().catch(() => undefined) : undefined;
      const file = credentialsPath();
      const access = permissions(file);
      const copies = mcpCopies();
      const value = {
        authenticated: account?.authenticated ?? false,
        key: credentials.apiKey ? maskKey(credentials.apiKey) : null,
        key_source: credentials.source,
        api_url: apiUrl,
        credentials_file: access ? file : null,
        credentials_mode: access?.mode ?? null,
        key_also_in: copies,
      };
      const source = { flag: "from --api-key", env: "from AGENTFS_KEY", config: "from the credentials file", none: "" }[credentials.source];
      out.data(value, () =>
        [
          header().trimEnd(),
          "",
          `  ${dot(value.authenticated, value.authenticated ? "Authenticated" : value.key ? "Key not accepted" : "Not authenticated")}`,
          "",
          `  ${dim("API key:")}      ${value.key ? `${value.key} ${dim(source)}` : dim("none")}`,
          `  ${dim("API URL:")}      ${value.api_url}`,
          `  ${dim("Credentials:")}  ${access ? `${file} ${access.private ? dim(`${access.mode}, only you can read it`) : fail(`${access.mode}, readable by others: chmod 600 ${file}`)}` : dim("not saved")}`,
          ...(copies.length > 0
            ? [`  ${dim("Also in:")}      ${copies.map((copy) => `${copy.name} ${dim(`(${copy.location})`)}`).join(", ")}`]
            : []),
          "",
          `  ${dim("Commands:")}`,
          `  agentfs login   ${dim(value.authenticated ? "Log in again" : "Log in with your browser")}`,
          `  agentfs logout  ${dim("Remove the saved key")}`,
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
      const failed: { file: string; error: ReturnType<typeof errorInfo> }[] = [];
      const project = await projectOf(client, text(flags, "project"));
      for (const local of args) {
        const name = basename(local);
        const progress = spinner(`Uploading ${name}`);
        try {
          results.push(
            await uploadFile(
              client,
              local,
              {
                project,
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
          if (args.length === 1) throw error;
          failed.push({ file: local, error: errorInfo(error) });
        }
      }
      if (args.length === 1) {
        out.data(results[0], () => results.map(fileLine).join("\n\n"));
        return;
      }
      out.data({ success: failed.length === 0, files: results, failed }, () =>
        [...results.map(fileLine), ...failed.map((item) => fail(`${clean(item.file)} ${dim(`${clean(item.error.message)} (${clean(item.error.code)})`)}`))].join("\n\n"),
      );
      return failed.length > 0 ? 1 : 0;
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
        limit: limitOf(text(flags, "limit")),
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
    usage: "agentfs download <file-id> [-o path] [--force]",
    auth: true,
    options: { output: { type: "string", short: "o" }, force: { type: "boolean" } },
    async run({ args, flags, client, out }) {
      const id = required(args, 0, "file id");
      const chosen = text(flags, "output");
      const target = resolve(chosen ?? safeFileName((await client.getFile(id)).name));
      if (existsSync(target) && flags.force !== true) throw new UsageError(`${target} already exists. Pass --force to overwrite it, or -o to pick another path.`);
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
      const deleted: string[] = [];
      const failed: { id: string; error: ReturnType<typeof errorInfo> }[] = [];
      for (const id of args) {
        try {
          await client.deleteFile(id, flags.permanent === true);
          deleted.push(id);
        } catch (error) {
          if (args.length === 1) throw error;
          failed.push({ id, error: errorInfo(error) });
        }
      }
      out.data({ success: failed.length === 0, deleted, failed, permanent: flags.permanent === true }, () =>
        [
          ...(deleted.length > 0 ? [ok(`${flags.permanent ? "Deleted" : "Moved to the trash"}: ${deleted.join(", ")}`)] : []),
          ...failed.map((item) => fail(`${clean(item.id)} ${dim(`${clean(item.error.message)} (${clean(item.error.code)})`)}`)),
        ].join("\n"),
      );
      return failed.length > 0 ? 1 : 0;
    },
  },
  share: {
    summary: "Create a time-limited link for a private file",
    usage: "agentfs share <file-id> [--expires-in 1h]",
    auth: true,
    options: { "expires-in": { type: "string" } },
    async run({ args, flags, client, out }) {
      const link = await client.accessUrl(required(args, 0, "file id"), text(flags, "expires-in"));
      out.data(link, () => `${clean(link.url)}${link.expires_at ? `\n${dim(`Expires ${clean(link.expires_at)}`)}` : ""}`);
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
        out.data(project, () => ok(`Created ${clean(project.name)}`));
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
  setup: {
    summary: "Install the agentfs skill and hosted MCP server into your agents",
    usage: "agentfs setup [skills|mcp] [--local] [--remove]",
    options: { local: { type: "boolean" }, remove: { type: "boolean" } },
    async run({ args, flags, out, apiKey, apiUrl }) {
      const what = args[0] ?? "all";
      if (!["all", "skills", "mcp"].includes(what)) throw new UsageError(`Unknown setup target ${what}. Use skills or mcp.`);
      const remove = flags.remove === true;
      const { lines, results } = installIntegrations({ what, remove, local: flags.local === true, apiKey, apiUrl });
      if (!remove) lines.push("", `  ${dim("Restart your agents to load AgentFS.")}`);
      out.data({ success: true, results }, () => [header().trimEnd(), "", ...lines].join("\n"));
    },
  },
};

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw new UsageError("No API key on stdin.");
  return value;
}

function safeFileName(name: string) {
  const base = basename(clean(name).replaceAll("\\", "/"));
  if (!base || base === "." || base === "..") throw new UsageError("The file has no safe local name. Pass -o to choose one.");
  return base;
}

function limitOf(value: string | undefined) {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError("--limit must be a whole number from 1 to 200.");
  return limit;
}

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
    `${dim("Start with:")} npx -y ${pkg.name}@latest init --all --browser`,
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
    const insecure = insecureApiUrl(credentials.apiUrl);
    if (insecure) throw new UsageError(insecure);
    if (command.auth && !credentials.apiKey) throw new UsageError("Not logged in. Run agentfs login, or set AGENTFS_KEY.");
    const code = await command.run({
      args: parsed.positionals,
      flags,
      client: createClient(credentials),
      out,
      apiKey: credentials.apiKey,
      apiUrl: credentials.apiUrl,
    });
    return code ?? 0;
  } catch (error) {
    const { code, message } = errorInfo(error);
    if (out.json) process.stdout.write(`${JSON.stringify({ success: false, error: { code, message } }, null, 2)}\n`);
    else process.stderr.write(`${fail(clean(message))}${error instanceof ApiError ? ` ${dim(`(${clean(error.code)})`)}` : ""}\n`);
    if (error instanceof UsageError && !out.json) process.stderr.write(`${dim(`Usage: ${command.usage}`)}\n`);
    return 1;
  }
}
