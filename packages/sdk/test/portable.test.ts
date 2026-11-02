import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

test("the core imports nothing from node: at load time", async () => {
  const root = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  for await (const name of new Glob("*.ts").scan(root)) {
    const source = await Bun.file(join(root, name)).text();
    if (/^\s*(import|export)\b[^;]*\bfrom\s+["'](node:|bun:|deno:)/mu.test(source)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
