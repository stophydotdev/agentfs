import { z } from "zod";

export const visibilities = ["public", "unlisted", "private"] as const;

export const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  label: z.string().nullable().optional(),
  content_type: z.string(),
  size_bytes: z.number(),
  sha256: z.string().nullable().optional(),
  etag: z.string().nullable().optional(),
  visibility: z.enum(visibilities),
  url: z.string().nullable(),
  markdown: z.string().nullable().optional(),
  expires_at: z.string().nullable(),
  agent_id: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
});

export const fileListSchema = z.object({
  items: z.array(fileSchema),
  next_cursor: z.string().nullable(),
});

export const uploadSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  transport: z.enum(["s3", "worker"]),
  part_size: z.number(),
  total_parts: z.number(),
  upload_url: z.string().optional(),
  uploaded_parts: z.array(z.object({ part_number: z.number() })).default([]),
  file: fileSchema.optional(),
});

export const partUrlsSchema = z.object({
  parts: z.array(z.object({ part_number: z.number(), url: z.string() })),
});

export const accessUrlSchema = z.object({
  url: z.string(),
  expires_at: z.string().nullable(),
});

export const revokeSchema = z.object({
  id: z.string(),
  access_version: z.number(),
});

export const accountSchema = z.object({
  authenticated: z.boolean(),
  id: z.string().optional(),
  default_project: z.string().optional(),
  plan: z.string().optional(),
  limits: z.object({ storage_bytes: z.number().nullable() }).partial().optional(),
  usage: z.object({ size_bytes: z.number(), file_count: z.number(), remaining_bytes: z.number().nullable().optional() }).nullable().optional(),
});

export const problemSchema = z.object({
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  retryable: z.boolean().optional(),
});

export type AgentFile = z.infer<typeof fileSchema>;
export type FileList = z.infer<typeof fileListSchema>;
export type UploadSession = z.infer<typeof uploadSessionSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Visibility = (typeof visibilities)[number];
