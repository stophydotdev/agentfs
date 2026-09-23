import { z } from "zod";

import pkg from "../package.json";

export const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  visibility: z.string(),
  url: z.string().nullable(),
  markdown: z.string().nullable().optional(),
  expires_at: z.string().nullable(),
  run_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  created_at: z.string(),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  default_visibility: z.string(),
  file_count: z.number(),
  size_bytes: z.number(),
  created_at: z.string(),
});

export const accountSchema = z.object({
  id: z.string().nullable().optional(),
  authenticated: z.boolean(),
  default_project: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
});

export const uploadSessionSchema = z.object({
  id: z.string(),
  transport: z.enum(["s3", "worker"]),
  part_size: z.number(),
  total_parts: z.number(),
  upload_url: z.string().optional(),
});

const partUrlsSchema = z.object({
  parts: z.array(z.object({ part_number: z.number(), url: z.string() })),
});

export const deviceSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

const deviceTokenSchema = z.object({
  api_key: z.string(),
  default_project: z.string().optional(),
});

const problemSchema = z.object({
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  retryable: z.boolean().optional(),
});

export type StoredFile = z.infer<typeof fileSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Account = z.infer<typeof accountSchema>;
export type UploadSession = z.infer<typeof uploadSessionSchema>;
export type Device = z.infer<typeof deviceSchema>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: number | undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiError(response: Response) {
  const body = problemSchema.safeParse(await response.json().catch(() => null));
  const code = (body.success && (body.data.code ?? body.data.title)) || `http_${response.status}`;
  const detail = (body.success && body.data.detail) || response.statusText || "Request failed.";
  const retryAfter = Number(response.headers.get("retry-after")) || undefined;
  return new ApiError(response.status, code, detail, retryAfter);
}

export type FileFilters = {
  project?: string;
  prefix?: string;
  path?: string;
  q?: string;
  run_id?: string;
  limit?: number;
  cursor?: string;
};

export type Client = ReturnType<typeof createClient>;

export function createClient({ apiKey, apiUrl }: { apiKey: string | undefined; apiUrl: string }) {
  const headers = (extra: Record<string, string> = {}) => ({
    "user-agent": `agentfs-cli/${pkg.version}`,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  });

  type Init = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

  const send = async (path: string, init: Init = {}) => {
    const response = await fetch(new URL(path, apiUrl), { ...init, headers: headers(init.headers) });
    if (!response.ok) throw await apiError(response);
    return response;
  };

  const json = async <T>(schema: z.ZodType<T>, path: string, init: Init = {}) =>
    schema.parse(await (await send(path, init)).json());

  const body = (value: unknown) => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

  return {
    apiUrl,
    hasKey: apiKey !== undefined,
    me: () => json(accountSchema, "/v1/me"),
    listFiles: (filters: FileFilters) => {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(filters)) {
        if (value !== undefined && value !== "") params.set(name, String(value));
      }
      return json(z.object({ items: z.array(fileSchema), next_cursor: z.string().nullable() }), `/v1/files?${params}`);
    },
    getFile: (id: string) => json(fileSchema, `/v1/files/${encodeURIComponent(id)}`),
    renameFile: (id: string, name: string) =>
      json(fileSchema, `/v1/files/${encodeURIComponent(id)}`, { method: "PATCH", ...body({ name }) }),
    deleteFile: async (id: string, permanent: boolean) => {
      await send(`/v1/files/${encodeURIComponent(id)}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
    },
    accessUrl: (id: string, expiresIn: string | undefined) =>
      json(z.object({ url: z.string(), expires_at: z.string().nullable() }), `/v1/files/${encodeURIComponent(id)}/access`, {
        method: "POST",
        ...body(expiresIn ? { expires_in: expiresIn } : {}),
      }),
    content: (id: string) => send(`/v1/files/${encodeURIComponent(id)}/content`),
    uploadForm: (form: FormData, extra: Record<string, string>) =>
      json(fileSchema, "/v1/files", { method: "POST", body: form, headers: extra }),
    createUpload: (input: Record<string, unknown>) => json(uploadSessionSchema, "/v1/uploads", { method: "POST", ...body(input) }),
    partUrls: (id: string, from: number, to: number) =>
      json(partUrlsSchema, `/v1/uploads/${encodeURIComponent(id)}/part-urls?from=${from}&to=${to}`),
    putPart: async (id: string, part: number, bytes: Blob) => {
      await send(`/v1/uploads/${encodeURIComponent(id)}/parts/${part}`, { method: "PUT", body: bytes });
    },
    completeUpload: async (id: string) => {
      const response = await send(`/v1/uploads/${encodeURIComponent(id)}/complete`, { method: "POST" });
      return response.status === 202 ? undefined : fileSchema.parse(await response.json());
    },
    abortUpload: async (id: string) => {
      await send(`/v1/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    },
    listProjects: () => json(z.object({ items: z.array(projectSchema) }), "/v1/projects"),
    createProject: (name: string) => json(projectSchema, "/v1/projects", { method: "POST", ...body({ name }) }),
    deleteProject: async (name: string) => {
      await send(`/v1/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    startDevice: () => json(deviceSchema, "/v1/auth/device", { method: "POST" }),
    claimDevice: (deviceCode: string) =>
      json(deviceTokenSchema, "/v1/auth/device/token", { method: "POST", ...body({ device_code: deviceCode }) }),
  };
}
