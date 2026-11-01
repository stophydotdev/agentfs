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

export const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const lastSegment = (path: string) => path.split("/").filter((part) => part !== "").at(-1) ?? "";
