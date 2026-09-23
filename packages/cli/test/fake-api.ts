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

export function fakeApi(options: { partSize?: number } = {}) {
  const seen: Seen[] = [];
  const parts = new Map<number, string>();
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
      if (request.headers.get("authorization") !== "Bearer afs_test") {
        return Response.json({ code: "unauthorized", detail: "Missing or invalid API key." }, { status: 401 });
      }
      if (url.pathname === "/v1/me") return Response.json({ id: "org_1", authenticated: true, default_project: "default", plan: "Free" });
      if (url.pathname === "/v1/files" && request.method === "POST") {
        return Response.json(file(entry.form?.path ?? `default/${(entry.form?.file ?? "file:x").slice(5)}`), { status: 201 });
      }
      if (url.pathname === "/v1/uploads" && request.method === "POST") {
        const input = JSON.parse(entry.body) as { path: string; size_bytes: number };
        const partSize = options.partSize ?? 4;
        return Response.json({ id: "up_1", transport: "worker", part_size: partSize, total_parts: Math.ceil(input.size_bytes / partSize) }, { status: 201 });
      }
      const part = url.pathname.match(/^\/v1\/uploads\/up_1\/parts\/(\d+)$/);
      if (part && request.method === "PUT") {
        parts.set(Number(part[1]), entry.body);
        return Response.json({ part_number: Number(part[1]) });
      }
      if (url.pathname === "/v1/uploads/up_1/complete") return Response.json(file("default/big.txt"));
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, parts, stop: () => server.stop(true) };
}
