import { afterAll, expect, test } from "bun:test";
import { AgentFS } from "../src/index";
import { startStub } from "./stub";

const stub = startStub();
afterAll(() => stub.stop());
process.env.AGENTFS_KEY = `afs_${stub.account}.0.${"d".repeat(64)}`;
process.env.AGENTFS_URL = stub.url;

test("Turso's README quick-start runs with only the import line changed", async () => {
  const pdfBuffer = Buffer.from("%PDF-1.7 fake report");

  const agent = await AgentFS.open({ id: "my-agent" });

  await agent.kv.set("user:preferences", { theme: "dark" });
  const prefs = await agent.kv.get("user:preferences");

  await agent.fs.writeFile("/output/report.pdf", pdfBuffer);
  const files = await agent.fs.readdir("/output");

  const callId = await agent.tools.record(
    "web_search",
    Date.now() / 1000,
    Date.now() / 1000 + 1.5,
    { query: "AI" },
    { results: ["a", "b"] },
  );

  expect(prefs).toEqual({ theme: "dark" });
  expect(files).toEqual(["report.pdf"]);
  expect((await agent.fs.readFile("/output/report.pdf")).equals(pdfBuffer)).toBe(true);
  expect(await agent.tools.get(callId)).toMatchObject({
    name: "web_search",
    parameters: { query: "AI" },
    result: { results: ["a", "b"] },
    status: "success",
    duration_ms: 1500,
  });
  expect([...stub.files.keys()]).toEqual(["my-agent/output/report.pdf"]);
  expect([...stub.kv.keys()]).toEqual(["my-agent/user:preferences"]);

  const ephemeral = await AgentFS.open();
  await ephemeral.kv.set("scratch", 1);
  expect(await ephemeral.kv.get<number>("scratch")).toBe(1);
});
