import type { Bytes } from "./bytes.js";
import { SDK_VERSION } from "./config.js";
import { AgentFSError, fromProblem } from "./errors.js";
import { segments } from "./paths.js";
import { inBrowser } from "./runtime.js";
import {
  type FileInfo,
  type Json,
  readDiff,
  readEvents,
  readFile,
  readKey,
  readKvItem,
  readKvPage,
  readLinkStatus,
  readLimits,
  readListing,
  readPartUrls,
  readProblem,
  readRestored,
  readSnapshot,
  readStarted,
  readToolEvent,
} from "./wire.js";

const PART_WORKERS = 4;
const IDENTITY: Record<string, string> = inBrowser() ? {} : { "user-agent": `agentfs-sdk/${SDK_VERSION}` };

export type Headed =
  | { kind: "file"; file: FileInfo }
  | { kind: "missing"; requestId: string | null };

type Init = { method?: string; body?: BodyInit; headers?: Record<string, string> };

const failure = async (response: Response) => {
  const requestId = response.headers.get("x-request-id");
  const problem = readProblem(await response.json().catch(() => null));
  if (problem !== null) return fromProblem(problem, response.status, requestId);
  const missing = response.status === 404;
  return new AgentFSError({
    code: missing ? "ENOENT" : String(response.status),
    message: `${missing ? "not_found" : response.status}: ${response.statusText}`,
    agentfsCode: missing ? "not_found" : null,
    requestId,
    status: response.status,
  });
};

const attempt = async (url: string, init: Init) => {
  const response = await fetch(url, { ...init, headers: { ...IDENTITY, ...init.headers } });
  if (!response.ok) throw await failure(response);
  return response;
};

const withRetry = async (url: string, init: Init) => {
  try {
    return await attempt(url, init);
  } catch (error) {
    if (!(error instanceof AgentFSError) || error.agentfsCode !== "idempotency_in_progress") throw error;
    await new Promise((done) => setTimeout(done, (error.retryAfter ?? 1) * 1000));
    return attempt(url, init);
  }
};

export const signUp = async (url: string) =>
  readKey(await (await withRetry(`${url}/v1/signup`, { method: "POST" })).json());

const json = (method: string, value: unknown): Init => ({
  method,
  body: JSON.stringify(value),
  headers: { "content-type": "application/json" },
});

export class Client {
  constructor(
    readonly url: string,
    readonly key: string,
    private readonly agent: string | undefined = undefined,
  ) {}

  private send(path: string, init: Init = {}) {
    const method = init.method ?? "GET";
    const mutates = method !== "GET" && method !== "HEAD";
    return withRetry(`${this.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(mutates ? { "idempotency-key": crypto.randomUUID() } : {}),
        ...(mutates && this.agent !== undefined ? { "x-agentfs-agent": this.agent } : {}),
        ...init.headers,
      },
    });
  }

  private async read(path: string, init: Init = {}): Promise<unknown> {
    return (await this.send(path, init)).json();
  }

  async head(path: string): Promise<Headed> {
    const response = await this.send(`/v1/files/${segments(path)}`, { method: "HEAD" }).catch(
      (error: unknown) => {
        if (error instanceof AgentFSError && error.agentfsCode === "not_found") return error;
        throw error;
      },
    );
    if (response instanceof AgentFSError) return { kind: "missing", requestId: response.requestId };
    const header = (name: string) => response.headers.get(name);
    const lastModified = header("last-modified");
    const url = header("x-agentfs-url");
    const etag = header("etag");
    const size = Number(header("content-length"));
    if (lastModified === null || url === null || etag === null || !Number.isFinite(size)) {
      throw new AgentFSError({ code: "bad_response", message: "bad_response: HEAD answer is missing headers." });
    }
    return {
      kind: "file",
      file: {
        path,
        size,
        sha256: etag.replaceAll('"', ""),
        contentType: header("content-type") ?? "application/octet-stream",
        updatedAt: new Date(lastModified).toISOString(),
        url,
      },
    };
  }

  page(prefix: string, delimiter: string, cursor: string) {
    const query = new URLSearchParams({ prefix, cursor, ...(delimiter === "" ? {} : { delimiter }) });
    return this.read(`/v1/files?${query}`).then(readListing);
  }

  async list(prefix: string, delimiter: string) {
    const files: FileInfo[] = [];
    const folders: string[] = [];
    let cursor = "";
    do {
      const next = await this.page(prefix, delimiter, cursor);
      files.push(...next.files);
      folders.push(...next.folders);
      cursor = next.cursor ?? "";
    } while (cursor !== "");
    return { files, folders };
  }

  async put(path: string, body: Bytes, sha256: string) {
    return readFile(
      await this.read(`/v1/files/${segments(path)}`, {
        method: "PUT",
        body,
        headers: { "x-sha256": sha256 },
      }),
    );
  }

  async remove(path: string) {
    await this.send(`/v1/files/${segments(path)}`, { method: "DELETE" });
  }

  async removeFolder(prefix: string) {
    await this.send(`/v1/files?${new URLSearchParams({ prefix })}`, { method: "DELETE" });
  }

  async move(from: string, to: string) {
    await this.send("/v1/files/move", json("POST", { from, to }));
  }

  async link(files: { path: string; sha256: string; size: number }[]) {
    return readLinkStatus(await this.read("/v1/files", json("POST", { files })));
  }

  async limits() {
    return readLimits(await this.read("/v1/limits"));
  }

  async bytesAt(url: string, range?: { start: number; end: number }): Promise<Uint8Array> {
    const response = await attempt(url, {
      headers: range === undefined ? {} : { range: `bytes=${range.start}-${range.end}` },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (range === undefined || response.status === 206) return bytes;
    return bytes.slice(range.start, range.end + 1);
  }

  async uploadDirect(path: string, body: Bytes, sha256: string) {
    const started = readStarted(
      await this.read("/v1/uploads", json("POST", { path, sha256, size: body.byteLength, direct: true })),
    );
    const base = `/v1/uploads/${started.upload}/${encodeURIComponent(started.uploadId)}`;
    const partCount = Math.ceil(body.byteLength / started.partBytes);
    const urls = new Map(started.partUrls.map((url, index) => [index + 1, url]));
    let refill: Promise<void> | null = null;
    const fetchUrls = async (from: number) => {
      const page = readPartUrls(
        await this.read(`${base}/parts?${new URLSearchParams({ from: String(from) })}`),
      );
      page.partUrls.forEach((url, index) => urls.set(page.from + index, url));
    };
    const urlFor = async (number: number) => {
      for (let tries = 0; !urls.has(number); tries += 1) {
        if (tries > partCount) {
          throw new AgentFSError({ code: "bad_response", message: `bad_response: no URL for part ${number}.` });
        }
        refill ??= fetchUrls(number).finally(() => {
          refill = null;
        });
        await refill;
      }
      return urls.get(number) ?? "";
    };
    const parts: { partNumber: number; etag: string }[] = [];
    let next = 1;
    const worker = async () => {
      while (next <= partCount) {
        const number = next;
        next += 1;
        const start = (number - 1) * started.partBytes;
        const slice = body.subarray(start, Math.min(start + started.partBytes, body.byteLength));
        const response = await attempt(await urlFor(number), { method: "PUT", body: slice });
        const etag = response.headers.get("etag");
        if (etag === null) {
          throw new AgentFSError({ code: "bad_response", message: "bad_response: storage sent no ETag." });
        }
        parts.push({ partNumber: number, etag });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PART_WORKERS, partCount) }, worker));
      parts.sort((a, b) => a.partNumber - b.partNumber);
      return readFile(await this.read(`${base}/complete`, json("POST", { path, sha256, parts })));
    } catch (error) {
      await this.send(base, { method: "DELETE" }).catch(() => null);
      throw error;
    }
  }

  async snapshot(name: string, prefix: string) {
    return readSnapshot(await this.read("/v1/snapshots", json("POST", { name, prefix })));
  }

  async restore(name: string) {
    return readRestored(
      await this.read(`/v1/snapshots/${encodeURIComponent(name)}/restore`, json("POST", {})),
    );
  }

  async diff(from: string, to: string | undefined) {
    const query = new URLSearchParams({ from, ...(to === undefined ? {} : { to }) });
    return readDiff(await this.read(`/v1/diff?${query}`));
  }

  async kvGet<T>(key: string): Promise<{ item: ReturnType<typeof readKvItem>; value: T } | null> {
    const response = await this.send(`/v1/kv/${segments(key)}`).catch((error: unknown) => {
      if (error instanceof AgentFSError && error.agentfsCode === "not_found") return null;
      throw error;
    });
    if (response === null) return null;
    const body = await response.text();
    const item = readKvItem(JSON.parse(body));
    const typed: { value: T } = JSON.parse(body);
    return { item, value: typed.value };
  }

  async kvSet(key: string, body: string) {
    await this.send(`/v1/kv/${segments(key)}`, {
      method: "PUT",
      body,
      headers: { "content-type": "application/json" },
    });
  }

  async kvRemove(key: string) {
    await this.send(`/v1/kv/${segments(key)}`, { method: "DELETE" });
  }

  async kvList<T>(prefix: string) {
    const entries: { key: string; value: T }[] = [];
    let cursor = "";
    do {
      const response = await this.send(`/v1/kv?${new URLSearchParams({ prefix, cursor })}`);
      const body = await response.text();
      const page = readKvPage(JSON.parse(body));
      const typed: { items: { value: T }[] } = JSON.parse(body);
      page.items.forEach((item, index) => {
        const entry = typed.items[index];
        if (entry !== undefined) entries.push({ key: item.key, value: entry.value });
      });
      cursor = page.cursor ?? "";
    } while (cursor !== "");
    return entries;
  }

  async logTool(event: {
    name: string;
    input: Json | undefined;
    output: Json | undefined;
    status: "ok" | "error";
    durationMs: number;
    startedAt: string;
  }) {
    return readToolEvent(await this.read("/v1/events", json("POST", { op: "tool", ...event })));
  }

  async toolEvents(cursor: string) {
    return readEvents(
      await this.read(`/v1/events?${new URLSearchParams({ op: "tool", limit: "1000", cursor })}`),
    );
  }
}
