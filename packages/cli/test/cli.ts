import { join } from "node:path";

const entry = join(import.meta.dir, "..", "src", "index.ts");

export const start = (
  server: { url: URL },
  config: string,
  args: string[],
  cwd = process.cwd(),
  input?: string,
  forceText = true,
) =>
  Bun.spawn(["bun", entry, ...(forceText && !args.includes("--json") ? ["--no-json"] : []), ...args], {
    cwd,
    env: { ...process.env, AGENTFS_URL: server.url.href, XDG_CONFIG_HOME: config },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });

export const runner = (server: { url: URL }, config: string, cwd = process.cwd()) => {
  const run = async (args: string[], input?: string, forceText = true) => {
    const child = start(server, config, args, cwd, input, forceText);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  return Object.assign((...args: string[]) => run(args), {
    stdin: (input: string, ...args: string[]) => run(args, input),
    piped: (...args: string[]) => run(args, undefined, false),
  });
};
