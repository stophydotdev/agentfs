import { createHash } from "node:crypto";

type Stored = { bytes: Uint8Array<ArrayBuffer>; sha256: string; updatedAt: Date };
type Upload = { path: string; size: number; parts: Map<number, Uint8Array<ArrayBuffer>> };
type Event = {
  id: string;
  at: string;
  op: "tool";
  name: string;
  input: unknown;
  output: unknown;
  status: string;
  durationMs: number;
};

export type StubOptions = {
  maxFileBytes?: number;
  partBytes?: number;
  urlsPerBatch?: number;
  pageSize?: number;
};

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const startStub = (options: StubOptions = {}) => {
  const maxFileBytes = options.maxFileBytes ?? 90 * 1024 * 1024;
  const partBytes = options.partBytes ?? 1024 * 1024;
  const urlsPerBatch = options.urlsPerBatch ?? 1000;
  const pageSize = options.pageSize ?? 1000;
  const files = new Map<string, Stored>();
  const kv = new Map<string, { value: unknown; version: number; updatedAt: string }>();
  const events: Event[] = [];
  const snapshots = new Map<string, { prefix: string; files: Map<string, Stored> }>();
  const uploads = new Map<string, Upload>();
  const seen = { userAgents: new Set<string>(), writeAgents: [] as (string | null)[], readAgents: [] as (string | null)[], signups: 0, partFetches: 0, authorizations: new Set<string>(), aborted: 0, requests: [] as string[] };
  let requestCounter = 0;
  let nextEvent = 1;

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const origin = url.origin;
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        Response.json(body, { status, headers: { "x-request-id": requestId, ...headers } });
      const problem = (code: string, message: string, status: number) =>
        reply({ error: { code, message, retryAfter: null, requestId } }, status);
      const linkOf = (path: string) =>
        `${origin}/${ACCOUNT}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const describe = (path: string, stored: Stored) => ({
        path,
        size: stored.bytes.byteLength,
        sha256: stored.sha256,
        contentType: "application/octet-stream",
        agent: null,
        session: null,
        commit: null,
        updatedAt: stored.updatedAt.toISOString(),
        expiresAt: null,
        verified: true,
        url: linkOf(path),
      });
      seen.requests.push(`${request.method} ${url.pathname}`);
      seen.userAgents.add(request.headers.get("user-agent") ?? "");
      if (url.pathname.startsWith("/v1/")) {
        const target = request.method === "GET" || request.method === "HEAD" ? seen.readAgents : seen.writeAgents;
        target.push(request.headers.get("x-agentfs-agent"));
      }

      if (request.method === "POST" && url.pathname === "/v1/signup") {
        seen.signups += 1;
        return reply({ key: `afs_${ACCOUNT}.0.${"a".repeat(64)}` }, 201);
      }

      if (url.pathname.startsWith(`/${ACCOUNT}/`)) {
        const path = decodeURIComponent(url.pathname.slice(ACCOUNT.length + 2));
        const stored = files.get(path);
        if (stored === undefined) return problem("not_found", "Nothing is here.", 404);
        const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get("range") ?? "");
        if (range === null) return new Response(stored.bytes);
        const [, from = "0", to = "0"] = range;
        return new Response(stored.bytes.slice(Number(from), Number(to) + 1), { status: 206 });
      }

      const storage = /^\/storage\/([^/]+)\/(\d+)$/u.exec(url.pathname);
      if (storage !== null && request.method === "PUT") {
        const upload = uploads.get(storage[1] ?? "");
        if (upload === undefined) return problem("upload_failed", "No such upload.", 409);
        upload.parts.set(Number(storage[2]), new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { headers: { etag: `"part-${storage[2]}"` } });
      }

      const authorization = request.headers.get("authorization");
      if (authorization === null || !authorization.startsWith("Bearer afs_")) {
        return problem("unauthorized", "Send your key.", 401);
      }
      seen.authorizations.add(authorization);

      if (request.method === "GET" && url.pathname === "/v1/limits") {
        let used = 0;
        for (const stored of files.values()) used += stored.bytes.byteLength;
        return reply({ plan: "free", usedBytes: used, files: files.size, maxFileBytes });
      }

      if (url.pathname.startsWith("/v1/files") && !url.pathname.startsWith("/v1/files/move")) {
        const path = decodeURIComponent(url.pathname.slice("/v1/files/".length));
        const isCollection = url.pathname === "/v1/files";
        if (request.method === "GET" && isCollection) {
          const prefix = url.searchParams.get("prefix") ?? "";
          const delimiter = url.searchParams.get("delimiter") ?? "";
          const all = [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
          const direct = delimiter === "" ? all : all.filter((key) => !key.slice(prefix.length).includes("/"));
          const folders =
            delimiter === ""
              ? []
              : [...new Set(all.filter((key) => key.slice(prefix.length).includes("/")).map((key) => `${prefix}${key.slice(prefix.length).split("/")[0]}/`))];
          const start = Number(url.searchParams.get("cursor") || "0");
          const slice = direct.slice(start, start + pageSize);
          const more = start + pageSize < direct.length;
          const stored = (key: string) => {
            const found = files.get(key);
            if (found === undefined) throw new Error(key);
            return found;
          };
          return reply({
            files: slice.map((key) => describe(key, stored(key))),
            folders: start === 0 ? folders : [],
            cursor: more ? String(start + pageSize) : null,
          });
        }
        if (request.method === "DELETE" && isCollection) {
          const prefix = url.searchParams.get("prefix") ?? "";
          if (!prefix.endsWith("/")) return problem("invalid_path", "Use a folder.", 400);
          let deleted = 0;
          for (const key of [...files.keys()]) {
            if (key.startsWith(prefix)) {
              files.delete(key);
              deleted += 1;
            }
          }
          return reply({ prefix, deleted });
        }
        if (request.method === "POST" && isCollection) {
          const body: { files: { path: string; sha256: string; size: number }[] } = await request.json();
          const results = body.files.map((entry) => {
            const known = [...files.values()].find((stored) => stored.sha256 === entry.sha256);
            if (known === undefined) return { path: entry.path, status: "missing", current: null };
            const stored = { ...known, updatedAt: new Date() };
            files.set(entry.path, stored);
            return { ...describe(entry.path, stored), status: "linked" };
          });
          return reply({ files: results });
        }
        if (request.method === "PUT" && path.startsWith("locked/")) {
          return problem("key_scope", "This key can't do that here.", 403);
        }
        if (request.method === "PUT" && path.startsWith("full/")) {
          return problem("storage_cap_reached", "This account reached its storage cap.", 413);
        }
        if (request.method === "PUT") {
          const bytes = new Uint8Array(await request.arrayBuffer());
          const declared = request.headers.get("x-sha256");
          if (declared !== sha(bytes)) return problem("sha256_mismatch", "Bytes do not match.", 400);
          const stored = { bytes, sha256: declared, updatedAt: new Date() };
          files.set(path, stored);
          return reply({ ...describe(path, stored), status: "uploaded" });
        }
        if (request.method === "HEAD") {
          const stored = files.get(path);
          if (stored === undefined) return new Response(null, { status: 404, headers: { "x-request-id": requestId } });
          return new Response(null, {
            headers: {
              "x-request-id": requestId,
              "content-length": String(stored.bytes.byteLength),
              "content-type": "application/octet-stream",
              etag: `"${stored.sha256}"`,
              "last-modified": stored.updatedAt.toUTCString(),
              "x-agentfs-url": linkOf(path),
            },
          });
        }
        if (request.method === "DELETE") {
          files.delete(path);
          return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/files/move") {
        const { from, to }: { from: string; to: string } = await request.json();
        const keys = [...files.keys()].filter((key) => (from.endsWith("/") ? key.startsWith(from) : key === from));
        if (keys.length === 0) return problem("not_found", "Nothing is here.", 404);
        for (const key of keys) {
          const stored = files.get(key);
          if (stored === undefined) continue;
          files.delete(key);
          files.set(from.endsWith("/") ? to + key.slice(from.length) : to, stored);
        }
        return reply({ from, to, moved: keys.length });
      }

      if (request.method === "POST" && url.pathname === "/v1/uploads") {
        const body: { path: string; size: number; direct: boolean } = await request.json();
        const token = crypto.randomUUID();
        uploads.set(token, { path: body.path, size: body.size, parts: new Map() });
        const count = Math.ceil(body.size / partBytes);
        const partUrls = Array.from({ length: Math.min(count, urlsPerBatch) }, (_, index) => `${origin}/storage/${token}/${index + 1}`);
        return reply({ upload: token, uploadId: "multipart-1", partBytes, parts: count, partUrls }, 201);
      }
      const parts = /^\/v1\/uploads\/([^/]+)\/([^/]+)\/(parts|complete)$/u.exec(url.pathname);
      if (parts !== null && request.method === "GET" && parts[3] === "parts") {
        seen.partFetches += 1;
        const upload = uploads.get(parts[1] ?? "");
        if (upload === undefined) return problem("upload_failed", "No such upload.", 409);
        const from = Number(url.searchParams.get("from"));
        const count = Math.ceil(upload.size / partBytes);
        const numbers = Array.from({ length: count }, (_, index) => index + 1).filter((number) => number >= from).slice(0, urlsPerBatch);
        return reply({ from, partUrls: numbers.map((number) => `${origin}/storage/${parts[1]}/${number}`) });
      }
      if (parts !== null && request.method === "POST" && parts[3] === "complete") {
        const upload = uploads.get(parts[1] ?? "");
        if (upload === undefined) return problem("upload_failed", "No such upload.", 409);
        const body: { path: string; sha256: string; parts: { partNumber: number; etag: string }[] } = await request.json();
        const chunks = body.parts.map((part) => upload.parts.get(part.partNumber) ?? new Uint8Array(0));
        const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (sha(bytes) !== body.sha256) return problem("upload_incomplete", "Bytes do not match.", 400);
        const stored = { bytes, sha256: body.sha256, updatedAt: new Date() };
        files.set(body.path, stored);
        return reply({ ...describe(body.path, stored), verified: false, status: "uploaded" });
      }
      const abort = /^\/v1\/uploads\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
      if (abort !== null && request.method === "DELETE") {
        uploads.delete(abort[1] ?? "");
        seen.aborted += 1;
        return new Response(null, { status: 204 });
      }

      if (url.pathname.startsWith("/v1/kv")) {
        const key = decodeURIComponent(url.pathname.slice("/v1/kv/".length));
        if (request.method === "GET" && url.pathname === "/v1/kv") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const keys = [...kv.keys()].filter((entry) => entry.startsWith(prefix)).sort();
          const start = Number(url.searchParams.get("cursor") || "0");
          const slice = keys.slice(start, start + pageSize);
          return reply({
            items: slice.map((entry) => ({ key: entry, ...kv.get(entry), expiresAt: null })),
            cursor: start + pageSize < keys.length ? String(start + pageSize) : null,
          });
        }
        if (request.method === "PUT") {
          const value: unknown = await request.json();
          const version = (kv.get(key)?.version ?? 0) + 1;
          const item = { value, version, updatedAt: new Date().toISOString() };
          kv.set(key, item);
          return reply({ key, ...item, expiresAt: null });
        }
        const item = kv.get(key);
        if (request.method === "GET") {
          return item === undefined ? problem("not_found", "Nothing is here.", 404) : reply({ key, ...item, expiresAt: null });
        }
        if (request.method === "DELETE") {
          kv.delete(key);
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === "/v1/events" && request.method === "POST") {
        const body: { name: string; input?: unknown; output?: unknown; status: string; durationMs: number; startedAt: string } = await request.json();
        const event: Event = {
          id: String(nextEvent).padStart(20, "0"),
          at: body.startedAt,
          op: "tool",
          name: body.name,
          input: body.input ?? null,
          output: body.output ?? null,
          status: body.status,
          durationMs: body.durationMs,
        };
        nextEvent += 1;
        events.push(event);
        return reply({ ...event, path: null, from: null, sha256: null, size: null, agent: null, session: null, commit: null }, 201);
      }
      if (url.pathname === "/v1/events" && request.method === "GET") {
        const newest = [...events].reverse();
        const start = Number(url.searchParams.get("cursor") || "0");
        const slice = newest.slice(start, start + pageSize);
        return reply({
          events: slice,
          cursor: start + pageSize < newest.length ? String(start + pageSize) : null,
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/snapshots") {
        const { name, prefix }: { name: string; prefix: string } = await request.json();
        const taken = new Map([...files].filter(([key]) => key.startsWith(prefix)));
        snapshots.set(name, { prefix, files: taken });
        let bytes = 0;
        for (const stored of taken.values()) bytes += stored.bytes.byteLength;
        return reply({ name, prefix, files: taken.size, bytes, createdAt: new Date().toISOString() }, 201);
      }
      const restore = /^\/v1\/snapshots\/([^/]+)\/restore$/u.exec(url.pathname);
      if (restore !== null && request.method === "POST") {
        const snapshot = snapshots.get(decodeURIComponent(restore[1] ?? ""));
        if (snapshot === undefined) return problem("snapshot_not_found", "No snapshot has this name.", 404);
        let deleted = 0;
        for (const key of [...files.keys()]) {
          if (key.startsWith(snapshot.prefix) && !snapshot.files.has(key)) {
            files.delete(key);
            deleted += 1;
          }
        }
        for (const [key, stored] of snapshot.files) files.set(key, stored);
        return reply({ name: decodeURIComponent(restore[1] ?? ""), to: snapshot.prefix, restored: snapshot.files.size, deleted });
      }
      if (request.method === "GET" && url.pathname === "/v1/diff") {
        const from = snapshots.get(url.searchParams.get("from") ?? "");
        if (from === undefined) return problem("snapshot_not_found", "No snapshot has this name.", 404);
        const target = url.searchParams.get("to");
        const to = target === null ? new Map([...files].filter(([key]) => key.startsWith(from.prefix))) : snapshots.get(target)?.files;
        if (to === undefined) return problem("snapshot_not_found", "No snapshot has this name.", 404);
        return reply({
          from: url.searchParams.get("from"),
          to: target,
          added: [...to].filter(([key]) => !from.files.has(key)).map(([path, stored]) => ({ path, sha256: stored.sha256, size: stored.bytes.byteLength })),
          changed: [...to]
            .filter(([key, stored]) => from.files.has(key) && from.files.get(key)?.sha256 !== stored.sha256)
            .map(([path, stored]) => ({ path, fromSha256: from.files.get(path)?.sha256, toSha256: stored.sha256, size: stored.bytes.byteLength })),
          removed: [...from.files].filter(([key]) => !to.has(key)).map(([path, stored]) => ({ path, sha256: stored.sha256 })),
        });
      }

      return problem("not_found", "Nothing is here.", 404);
    },
  });

  return {
    url: server.url.href.replace(/\/$/u, ""),
    files,
    kv,
    events,
    seen,
    account: ACCOUNT,
    stop: () => server.stop(true),
  };
};
