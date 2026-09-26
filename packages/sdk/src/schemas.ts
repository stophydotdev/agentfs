import { z } from "zod";

export const fileSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  etag: z.string().nullable().optional(),
  visibility: z.enum(["public", "unlisted", "private"]),
  url: z.string().nullable(),
  versioned_url: z.string().nullable().optional(),
  permalink: z.string().nullable().optional(),
  cache: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
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
  upload_url_expires_at: z.string().optional(),
  expires_at: z.string().optional(),
  expected_size_bytes: z.number().optional(),
  uploaded_parts: z.array(z.object({ part_number: z.number(), etag: z.string().optional() })).default([]),
});

export const partUrlsSchema = z.object({
  parts: z.array(z.object({ part_number: z.number(), url: z.string() })),
});

export const signedUrlSchema = z.object({
  url: z.string(),
  expires_at: z.string().nullable(),
});

export const openUploadsSchema = z.object({
  items: z.array(z.object({ id: z.string(), path: z.string(), created_at: z.string() })),
});

export const deletedSchema = z.object({ deleted: z.number(), has_more: z.boolean() });

export const projectSettingsSchema = z.object({
  id: z.string(),
  default_visibility: z.enum(["public", "unlisted", "private"]),
  urls: z.object({ files: z.string(), sandbox: z.string() }),
});

export const accountSchema = z.object({
  default_project: z.string().optional(),
});

export const uploadTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  path: z.string(),
  callback_secret: z.string().nullable(),
});

export const s3CredentialsSchema = z.object({
  access_key_id: z.string(),
  secret_access_key: z.string(),
  session_token: z.string(),
  expiration: z.string(),
  endpoint: z.string(),
  region: z.string(),
});

export const problemSchema = z.object({
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  retryable: z.boolean().optional(),
});

export type StoredFile = z.infer<typeof fileSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type UploadSession = z.infer<typeof uploadSessionSchema>;
