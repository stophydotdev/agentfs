export type Seen = { method: string; path: string; headers: Headers; body: string; form?: Record<string, string> };

const file = (path: string) => ({
  id: "f_1",
  name: path.split("/").pop() ?? path,
  path: `/${path}`,
  content_type: "text/plain",
  size_bytes: 10,
  visibility: "unlisted",
  url: "https://f.agentfs.cloud/f/f_1",
  markdown: "[x](https://f.agentfs.cloud/f/f_1)",
  expires_at: null,
  created_at: "2026-09-23T00:00:00.000Z",
});

type Failure = { status: number; retryAfter?: string };

export type FakeOptions = {
  partSize?: number;
  transport?: "worker" | "s3" | "single";
  takenPaths?: string[];
  failures?: Record<number, Failure[]>;
  partDelayMs?: number;
  expireFirstUrl?: number[];
};

export function fakeApi(options: FakeOptions = {}) {
  const seen: Seen[] = [];
  const parts = new Map<number, string>();
  const failures = new Map(Object.entries(options.failures ?? {}).map(([part, list]) => [Number(part), [...list]]));
  const signatures = new Map<number, number>();
  const load = { inFlight: 0, maxInFlight: 0 };
  let session: { size: number; partSize: number; totalParts: number } | undefined;

  const receivePart = async (part: number, body: string) => {
    load.inFlight += 1;
    load.maxInFlight = Math.max(load.maxInFlight, load.inFlight);
    await Bun.sleep(options.partDelayMs ?? 0);
    load.inFlight -= 1;
    const failure = failures.get(part)?.shift();
    if (failure) {
      return Response.json({ code: "upload_unavailable", detail: `Part ${part} failed.` }, {
        status: failure.status,
        headers: failure.retryAfter ? { "retry-after": failure.retryAfter } : {},
      });
    }
    parts.set(part, body);
    return Response.json({ part_number: part });
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      const entry: Seen = { method: request.method, path: url.pathname + url.search, headers: request.headers, body: "" };
      if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
        const form = await request.formData();
        const entries: [string, string | File][] = Array.from(form.entries());
        entry.form = Object.fromEntries(entries.map(([name, value]) => [name, typeof value === "string" ? value : `file:${value.name}`]));
      } else {
        entry.body = await request.text();
      }
      seen.push(entry);
      const storage = url.pathname.match(/^\/storage\/(\d+)$/);
      if (storage && request.method === "PUT") {
        const part = Number(storage[1]);
        if (options.expireFirstUrl?.includes(part) && url.searchParams.get("sig") === "1") {
          return new Response("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", { status: 403 });
        }
        return receivePart(part, entry.body);
      }
      if (!request.headers.has("authorization") && url.pathname === "/v1/files" && request.method === "POST") {
        return Response.json({ ...file(`guest/${(entry.form?.file ?? "file:x").slice(5)}`), expires_at: "2026-09-24T00:00:00.000Z" }, { status: 201 });
      }
      if (request.headers.get("authorization") !== "Bearer afs_test") {
        return Response.json({ code: "unauthorized", detail: "Missing or invalid API key." }, { status: 401 });
      }
      if (url.pathname === "/v1/me") return Response.json({ id: "org_1", authenticated: true, default_project: "default", plan: "Free" });
      if (url.pathname === "/v1/files" && request.method === "POST" && options.takenPaths?.includes(entry.form?.path ?? "")) {
        return Response.json({ code: "path_exists", detail: `The path /${entry.form?.path} already exists.` }, { status: 409 });
      }
      if (url.pathname === "/v1/files" && request.method === "POST") {
        return Response.json(file(entry.form?.path ?? `default/${(entry.form?.file ?? "file:x").slice(5)}`), { status: 201 });
      }
      const sessionObject = () => {
        if (!session) return Response.json({ code: "upload_not_found" }, { status: 404 });
        const transport = options.transport ?? "worker";
        return Response.json({
          id: "up_1",
          status: "active",
          transport: transport === "worker" ? "worker" : "s3",
          part_size: session.partSize,
          total_parts: session.totalParts,
          uploaded_parts: [...parts.keys()].sort((a, b) => a - b).map((part_number) => ({ part_number })),
          ...(transport === "single" ? { upload_url: `${origin}/storage/1` } : {}),
        });
      };
      if (url.pathname === "/v1/uploads" && request.method === "POST") {
        const input = JSON.parse(entry.body) as { path: string; size_bytes: number };
        const partSize = options.transport === "single" ? input.size_bytes : (options.partSize ?? 4);
        session = { size: input.size_bytes, partSize, totalParts: Math.ceil(input.size_bytes / partSize) };
        return sessionObject();
      }
      if (url.pathname === "/v1/uploads/up_1" && request.method === "GET") return sessionObject();
      if (url.pathname === "/v1/uploads/up_1/part-urls") {
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        return Response.json({
          parts: Array.from({ length: to - from + 1 }, (_, index) => {
            const part = from + index;
            const signature = (signatures.get(part) ?? 0) + 1;
            signatures.set(part, signature);
            return { part_number: part, url: `${origin}/storage/${part}?sig=${signature}` };
          }),
        });
      }
      const part = url.pathname.match(/^\/v1\/uploads\/up_1\/parts\/(\d+)$/);
      if (part && request.method === "PUT") return receivePart(Number(part[1]), entry.body);
      if (url.pathname === "/v1/uploads/up_1/complete") return Response.json(file("default/big.txt"));
      if (url.pathname === "/v1/uploads/up_1" && request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, parts, load, stop: () => server.stop(true) };
}
