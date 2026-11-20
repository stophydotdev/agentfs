import { AgentFSError } from "./errors.js";

export const normalize = (path: string) => {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts;
};

export const folderPrefix = (folder: string) => {
  const parts = normalize(folder);
  return parts.length === 0 ? "" : `${parts.join("/")}/`;
};

/** Encodes a key or path for a URL. "." and ".." are refused: the URL parser would resolve them into a different route. */
export const segments = (path: string) =>
  path
    .split("/")
    .map((part) => {
      if (part === "." || part === "..") {
        throw new AgentFSError({ code: "EINVAL", message: `EINVAL: "${path}" has a "${part}" segment.` });
      }
      return encodeURIComponent(part);
    })
    .join("/");

export const lastSegment = (path: string) => path.split("/").filter((part) => part !== "").at(-1) ?? "";
