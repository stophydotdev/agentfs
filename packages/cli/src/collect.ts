import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type Local = { file: string; path: string };

const SECRET =
  /(^|\/)(\.env(\.(?!example$)[^/]+)?|[^/]+\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc)$/u;

const looksSecret = (path: string) => SECRET.test(path);

const isIgnored = (folder: string) => {
  const full = resolve(folder);
  try {
    execFileSync("git", ["-C", dirname(full), "check-ignore", "-q", basename(full)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

const gitFiles = (folder: string) => {
  if (isIgnored(folder)) return null;
  try {
    const listed = execFileSync(
      "git",
      ["-C", folder, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return listed.split("\0").filter((file) => file !== "" && isFile(join(folder, file)));
  } catch {
    return null;
  }
};

const folderFiles = async (folder: string) => {
  const tracked = gitFiles(folder);
  if (tracked !== null) return tracked;
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((file) => !file.startsWith(".git/"));
};

export const collect = async (paths: string[], to: string, includeSecrets: boolean) => {
  const folder = to.replace(/^\/+|\/+$/gu, "");
  const into = folder === "" ? "" : `${folder}/`;
  const found: Local[] = [];
  for (const path of paths) {
    const name = basename(resolve(path));
    if (!(await stat(path)).isDirectory()) {
      found.push({ file: path, path: `${into}${name}` });
      continue;
    }
    for (const file of await folderFiles(path)) {
      found.push({ file: join(path, file), path: `${into}${name}/${file}` });
    }
  }
  const skipped = includeSecrets ? [] : found.filter((local) => looksSecret(local.path));
  return { locals: found.filter((local) => !skipped.includes(local)), skipped };
};
