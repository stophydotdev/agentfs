import { Client, signUp } from "./client.js";
import { AgentFSError } from "./errors.js";
import { DEFAULT_URL } from "./config.js";
import { Filesystem } from "./fs.js";
import { KvStore } from "./kv.js";
import { folderPrefix } from "./paths.js";
import { openKeyFile, readEnv } from "./runtime.js";
import { ToolCalls } from "./tools.js";

export type AgentFSOptions = {
  key?: string;
  url?: string;
  prefix?: string;
  id?: string;
  path?: string;
  agent?: string;
};

const AGENT_NAME = /^[\w.:@/-]{1,128}$/u;

const resolveKey = async (given: string | undefined, url: string) => {
  if (given !== undefined && given !== "") return given;
  const fromEnv = readEnv("AGENTFS_KEY");
  if (fromEnv !== undefined) return fromEnv;
  const file = await openKeyFile();
  const saved = file === null ? null : await file.read();
  if (saved !== null) return saved;
  const key = await signUp(url);
  await file?.write(key);
  return key;
};

export class AgentFS {
  readonly fs: Filesystem;
  readonly kv: KvStore;
  readonly tools: ToolCalls;

  private constructor(
    private readonly client: Client,
    readonly prefix: string,
  ) {
    this.fs = new Filesystem(client, prefix);
    this.kv = new KvStore(client, prefix);
    this.tools = new ToolCalls(client);
  }

  static async open(options: AgentFSOptions = {}) {
    const url = (options.url ?? readEnv("AGENTFS_URL") ?? DEFAULT_URL).replace(/\/+$/u, "");
    const key = await resolveKey(options.key, url);
    const prefix = folderPrefix(options.prefix ?? options.id ?? "");
    const { agent } = options;
    if (agent !== undefined && !AGENT_NAME.test(agent)) {
      throw new AgentFSError({
        code: "EINVAL",
        message: "EINVAL: agent is 1 to 128 letters, digits and . : @ / - _ characters.",
      });
    }
    return new AgentFS(new Client(url, key, agent), prefix);
  }

  get key() {
    return this.client.key;
  }

  get url() {
    return this.client.url;
  }

  snapshot(name: string, folder = "/") {
    return this.client.snapshot(name, this.prefix + folderPrefix(folder));
  }

  restore(name: string) {
    return this.client.restore(name);
  }

  diff(from: string, to?: string) {
    return this.client.diff(from, to);
  }

  async close() {}
}
