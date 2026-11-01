import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "..", "install.sh");

const NEXT =
  "\nagentfs put <file or folder>   upload and get a link\nagentfs --help                 list every command\n";

type Fakes = { bun?: boolean; npm?: boolean; node?: string; agentfs?: boolean };

const install = async ({ bun, npm, node, agentfs }: Fakes) => {
  const bin = await mkdtemp(join(tmpdir(), "agentfs-install-"));
  const log = join(bin, "calls.log");
  const fake = async (name: string, body: string) => {
    const file = join(bin, name);
    await writeFile(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    await chmod(file, 0o755);
  };
  if (bun) await fake("bun", '[ "$1" = pm ] && echo /fake/bun/bin; exit 0');
  if (npm) await fake("npm", '[ "$1" = prefix ] && echo /fake/npm; exit 0');
  if (node !== undefined) await fake("node", `echo v${node}`);
  if (agentfs) await fake("agentfs", "echo 0.0.2");
  const run = Bun.spawn(["/bin/sh", script], {
    env: { PATH: bin, HOME: bin },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  const calls = (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  return { stdout, stderr, code, calls };
};

test("with Bun it runs bun add -g and shows the version and the next two commands", async () => {
  const result = await install({ bun: true, npm: true, node: "22.5.0", agentfs: true });
  expect(result.code).toBe(0);
  expect(result.calls).toEqual(["bun add -g @agentfs/cli", "bun pm bin -g", "agentfs --version"]);
  expect(result.stdout).toBe(`0.0.2\n${NEXT}`);
});

test("without Bun it uses npm when Node is 20.12 or newer", async () => {
  const result = await install({ npm: true, node: "20.12.0", agentfs: true });
  expect(result.code).toBe(0);
  expect(result.calls).toEqual([
    "node --version",
    "npm install -g @agentfs/cli",
    "npm prefix -g",
    "agentfs --version",
  ]);
  expect(result.stdout).toBe(`0.0.2\n${NEXT}`);
});

test("with neither Bun nor a new enough Node it names what to install and exits 1", async () => {
  for (const fakes of [{}, { npm: true }, { npm: true, node: "20.11.9" }, { npm: true, node: "18.19.0" }]) {
    const result = await install(fakes);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "agentfs needs Bun (https://bun.sh) or Node 20.12 or newer (https://nodejs.org) to install.\n",
    );
    expect(result.calls.some((call) => call.startsWith("npm install"))).toBe(false);
  }
});

test("when agentfs is not on PATH it prints the line to add the global bin directory", async () => {
  const result = await install({ bun: true });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    `agentfs is installed but not on your PATH. Add it with: export PATH="/fake/bun/bin:$PATH"\n${NEXT}`,
  );
});
