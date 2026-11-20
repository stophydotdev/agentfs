import { AgentFSError } from "./errors.js";

export type Bytes = Uint8Array<ArrayBuffer>;

export const owned = (bytes: Uint8Array): Bytes =>
  bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes.slice();

export const sha256Hex = async (bytes: Bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const UTF8 = new Set(["utf8", "utf-8"]);

const needBuffer = () => {
  if (typeof Buffer === "undefined") {
    throw new AgentFSError({
      code: "ENOSYS",
      message: "ENOSYS: Buffer is not available here. Pass an encoding to readFile, or use readBytes.",
    });
  }
  return Buffer;
};

export const encode = (text: string, encoding: BufferEncoding): Bytes =>
  UTF8.has(encoding) ? owned(new TextEncoder().encode(text)) : owned(needBuffer().from(text, encoding));

export const decode = (bytes: Uint8Array, encoding: BufferEncoding) =>
  UTF8.has(encoding)
    ? new TextDecoder().decode(bytes)
    : needBuffer().from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding);

export const toBuffer = (bytes: Uint8Array) =>
  needBuffer().from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
