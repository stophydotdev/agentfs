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
  takenPaths?: string[];
  failures?: Record<number, Failure[]>;
};

export function fakeApi(options: FakeOptions = {}) {
  const seen: Seen[] = [];
  const parts = new Map<number, string>();
  const failures = new Map(Object.entries(options.failures ?? {}).map(([part, list]) => [Number(part), [...list]]));
  let session: { size: number; partSize: number; totalParts: number } | undefined;

  const receivePart = (part: number, body: string) => {
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
      const entry: Seen = { method: request.method, path: url.pathname + url.search, headers: request.headers, body: "" };
      if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
        const form = await request.formData();
        const entries: [string, string | File][] = Array.from(form.entries());
        entry.form = Object.fromEntries(entries.map(([name, value]) => [name, typeof value === "string" ? value : `file:${value.name}`]));
      } else {
        entry.body = await request.text();
      }
      seen.push(entry);
      if (!request.headers.has("authorization") && url.pathname === "/v1/files" && request.method === "POST") {
        return Response.json({ ...file(`guest/${(entry.form?.file ?? "file:x").slice(5)}`), expires_at: "2026-09-24T00:00:00.000Z" }, { status: 201 });
      }
      if (request.headers.get("authorization") !== "Bearer afs_test") {
        return Response.json({ code: "unauthorized", detail: "Missing or invalid API key." }, { status: 401 });
      }
      if (url.pathname === "/v1/me") return Response.json({ id: "org_1", authenticated: true, default_project: "default", plan: "Free" });
      const raw = url.pathname.match(/^\/v1\/files\/(.+)$/);
      if (raw?.[1] && request.method === "PUT") {
        const path = decodeURIComponent(raw[1]);
        if (options.takenPaths?.includes(path) && request.headers.get("if-none-match") === "*") {
          return Response.json({ code: "path_exists", detail: `The path /${path} already exists.` }, { status: 409 });
        }
        return Response.json(file(path), { status: 201 });
      }
      const sessionObject = () => {
        if (!session) return Response.json({ code: "upload_not_found" }, { status: 404 });
        return Response.json({
          id: "up_1",
          status: "active",
          transport: "worker",
          part_size: session.partSize,
          total_parts: session.totalParts,
          uploaded_parts: [...parts.keys()].sort((a, b) => a - b).map((part_number) => ({ part_number })),
        });
      };
      if (url.pathname === "/v1/uploads" && request.method === "POST") {
        const input = JSON.parse(entry.body) as { path: string; size_bytes: number };
        const partSize = options.partSize ?? 4;
        session = { size: input.size_bytes, partSize, totalParts: Math.ceil(input.size_bytes / partSize) };
        return sessionObject();
      }
      const part = url.pathname.match(/^\/v1\/uploads\/up_1\/parts\/(\d+)$/);
      if (part && request.method === "PUT") return receivePart(Number(part[1]), entry.body);
      if (url.pathname === "/v1/uploads/up_1/complete") return Response.json(file("default/big.txt"));
      if (url.pathname === "/v1/uploads/up_1" && request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, parts, stop: () => server.stop(true) };
}
