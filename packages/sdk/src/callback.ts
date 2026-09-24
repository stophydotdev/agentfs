const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
};

export interface UploadCallback {
  type: "upload.completed";
  created_at: string;
  data: { file: { id: string; path: string; url: string | null; size_bytes: number; content_type: string; metadata?: Record<string, string> } };
}

export const verifyUploadCallback = async (
  secret: string,
  signatureHeader: string | null,
  body: string,
  toleranceSeconds = 300,
): Promise<UploadCallback | null> => {
  const timestamp = Number(/(?:^|,)t=(\d+)/.exec(signatureHeader ?? "")?.[1]);
  const signature = /(?:^|,)v1=([a-f0-9]+)/.exec(signatureHeader ?? "")?.[1];
  if (!signature || !Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
  return sameText(expected, signature) ? JSON.parse(body) : null;
};
