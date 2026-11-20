import type { Client } from "./client.js";
import { AgentFSError } from "./errors.js";
import { type Json, type ToolEvent, toJson } from "./wire.js";

export type ToolCall = {
  id: number;
  name: string;
  parameters?: Json;
  result?: Json;
  error?: string;
  status: "success" | "error";
  started_at: number;
  completed_at?: number;
  duration_ms?: number;
};

type Filter = { name?: string; since?: number; limit?: number };

const numericId = (id: string) => {
  const number = Number(id);
  if (!Number.isSafeInteger(number)) {
    throw new AgentFSError({ code: "bad_response", message: `bad_response: event id ${id} is too large.` });
  }
  return number;
};

const errorText = (output: Json | null) =>
  typeof output === "object" && output !== null && !Array.isArray(output) && typeof output.error === "string"
    ? output.error
    : "";

const toToolCall = (event: ToolEvent): ToolCall => {
  const started = Date.parse(event.at) / 1000;
  const failed = event.status === "error";
  return {
    id: numericId(event.id),
    name: event.name,
    ...(event.input === null ? {} : { parameters: event.input }),
    ...(failed || event.output === null ? {} : { result: event.output }),
    ...(failed ? { error: errorText(event.output) } : {}),
    status: failed ? "error" : "success",
    started_at: started,
    completed_at: started + event.durationMs / 1000,
    duration_ms: event.durationMs,
  };
};

export class ToolCalls {
  constructor(private readonly client: Client) {}

  async record(
    name: string,
    started_at: number,
    completed_at: number,
    parameters?: unknown,
    result?: unknown,
    error?: string,
  ): Promise<number> {
    const failed = error !== undefined && error !== "";
    const event = await this.client.logTool({
      name,
      input: toJson(parameters),
      output: failed ? { error } : toJson(result),
      status: failed ? "error" : "ok",
      durationMs: Math.max(0, Math.round((completed_at - started_at) * 1000)),
      startedAt: new Date(started_at * 1000).toISOString(),
    });
    return numericId(event.id);
  }

  private async *scan() {
    let cursor = "";
    do {
      const page = await this.client.toolEvents(cursor);
      yield* page.events;
      cursor = page.cursor ?? "";
    } while (cursor !== "");
  }

  async list({ name, since, limit }: Filter = {}): Promise<ToolCall[]> {
    const calls: ToolCall[] = [];
    for await (const event of this.scan()) {
      if (limit !== undefined && calls.length >= limit) break;
      const call = toToolCall(event);
      if (since !== undefined && call.started_at <= since) break;
      if (name === undefined || call.name === name) calls.push(call);
    }
    return calls;
  }

  async get(id: number): Promise<ToolCall | undefined> {
    for await (const event of this.scan()) {
      const found = numericId(event.id);
      if (found === id) return toToolCall(event);
      if (found < id) return undefined;
    }
    return undefined;
  }

  getByName(name: string, limit?: number) {
    return this.list({ name, limit });
  }

  getRecent(since: number, limit?: number) {
    return this.list({ since, limit });
  }
}
