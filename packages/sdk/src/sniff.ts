import { BlobError } from "./errors";

export const SNIFF_BYTES = 4100;

const matches = (bytes: Uint8Array, offset: number, signature: readonly number[]): boolean =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

const text = (bytes: Uint8Array, offset: number, value: string): boolean =>
  matches(bytes, offset, Array.from(value, (char) => char.charCodeAt(0)));

const uint32 = (bytes: Uint8Array, offset: number): number =>
  bytes.length < offset + 4 ? -1 : new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);

const BITMAP_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);

const CERTAIN = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "audio/wav", "video/x-msvideo",
  "application/pdf", "application/zip", "application/gzip", "application/x-7z-compressed",
  "application/x-rar-compressed", "application/x-bzip2",
]);

export const sniff = (bytes: Uint8Array): string | undefined => {
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return text(bytes, 12, "IHDR") ? "image/png" : undefined;
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (text(bytes, 0, "GIF87a") || text(bytes, 0, "GIF89a")) return "image/gif";
  if (text(bytes, 0, "RIFF")) {
    if (text(bytes, 8, "WEBP")) return "image/webp";
    if (text(bytes, 8, "WAVE")) return "audio/wav";
    if (text(bytes, 8, "AVI ")) return "video/x-msvideo";
    return undefined;
  }
  if (text(bytes, 0, "BM") && BITMAP_HEADERS.has(uint32(bytes, 14))) return "image/bmp";
  if (text(bytes, 0, "%PDF")) return "application/pdf";
  if ([[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]].some((signature) => matches(bytes, 0, signature))) return "application/zip";
  if (matches(bytes, 0, [0x1f, 0x8b])) return "application/gzip";
  if (matches(bytes, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed";
  if (matches(bytes, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "application/x-rar-compressed";
  const level = bytes[3] ?? 0;
  if (text(bytes, 0, "BZh") && level >= 0x31 && level <= 0x39 && matches(bytes, 4, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59])) return "application/x-bzip2";
  return undefined;
};

const FAMILIES: Record<string, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff", "image/avif", "image/heic", "image/heif", "image/x-icon"],
  video: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo", "video/mpeg", "video/ogg", "video/3gpp"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/opus", "audio/flac", "audio/aac", "audio/mp4", "audio/webm"],
};

const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/vnd.microsoft.icon": "image/x-icon",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/x-flac": "audio/flac",
  "audio/x-aac": "audio/aac",
  "video/avi": "video/x-msvideo",
  "video/msvideo": "video/x-msvideo",
  "application/x-gzip": "application/gzip",
  "application/x-zip-compressed": "application/zip",
  "application/vnd.rar": "application/x-rar-compressed",
};

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const canonical = (type: string): string => {
  const bare = type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALIASES[bare] ?? bare;
};

export const expandContentTypes = (allowed: readonly string[]): string[] => {
  if (allowed.length === 0) {
    throw new BlobError("invalid_content_type_pattern", { message: "contentTypes: empty list; omit the option to accept anything" });
  }
  const expanded = new Set<string>();
  for (const raw of allowed) {
    const pattern = raw.trim().toLowerCase();
    if (pattern.endsWith("/*")) {
      const family = FAMILIES[pattern.slice(0, -2)];
      if (!family) throw new BlobError("invalid_content_type_pattern", { message: `contentTypes: only image/*, video/* and audio/* are wildcards, got "${raw}"` });
      for (const type of family) expanded.add(canonical(type));
    } else if (MEDIA_TYPE.test(pattern)) {
      expanded.add(canonical(pattern));
    } else {
      throw new BlobError("invalid_content_type_pattern", { message: `contentTypes: expected a "type/subtype", got "${raw}"` });
    }
  }
  return [...expanded];
};

export const checkContentType = (declared: string, head: Uint8Array | undefined, allowed: readonly string[]): void => {
  const bare = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const wanted = canonical(bare);
  if (!allowed.includes(wanted)) {
    throw new BlobError("content_type_not_allowed", { message: `${bare} is not allowed (allowed: ${allowed.join(", ")})`, status: 415 });
  }
  const seen = head ? sniff(head) : undefined;
  if (seen === undefined || seen === wanted || !CERTAIN.has(wanted)) return;
  throw new BlobError("content_type_not_allowed", { message: `The bytes are ${seen}, which cannot be served as ${bare}`, status: 415 });
};
