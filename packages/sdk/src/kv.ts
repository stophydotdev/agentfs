import type { Client } from "./client.js";
import { AgentFSError } from "./errors.js";

export class KvStore {
  constructor(
    private readonly client: Client,
    private readonly prefix: string,
  ) {}

  private remote(key: string) {
    return `${this.prefix}${key}`;
  }

  async set(key: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value);
    if (body === undefined) {
      throw new AgentFSError({ code: "EINVAL", message: "EINVAL: the value has no JSON form." });
    }
    await this.client.kvSet(this.remote(key), body);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const found = await this.client.kvGet<T>(this.remote(key));
    return found === null ? undefined : found.value;
  }

  async list<T = unknown>(prefix: string): Promise<{ key: string; value: T }[]> {
    const entries = await this.client.kvList<T>(this.remote(prefix));
    return entries.map(({ key, value }) => ({ key: key.slice(this.prefix.length), value }));
  }

  async delete(key: string): Promise<void> {
    await this.client.kvRemove(this.remote(key));
  }
}

