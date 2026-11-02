import { CONFIG_DIR_NAME, KEY_FILE_NAME } from "./config.js";

const dig = (root: unknown, ...path: string[]): unknown =>
  path.reduce(
    (value, key) => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined),
    root,
  );

export const inBrowser = () =>
  dig(globalThis, "window") !== undefined && dig(globalThis, "document") !== undefined;

export const readEnv = (name: string): string | undefined => {
  try {
    const value = dig(globalThis, "process", "env", name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
};

type Files = {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
};
type Home = { homedir(): string };

const FILES_MODULE = "node:fs/promises";
const HOME_MODULE = "node:os";

const hasFiles = (files: Partial<Files>) =>
  typeof files.readFile === "function" &&
  typeof files.writeFile === "function" &&
  typeof files.mkdir === "function";

export const openKeyFile = async () => {
  try {
    const files: Files = await import(FILES_MODULE);
    const home: Home = await import(HOME_MODULE);
    if (!hasFiles(files) || typeof home.homedir !== "function") return null;
    const directory = `${readEnv("XDG_CONFIG_HOME") ?? `${home.homedir()}/.config`}/${CONFIG_DIR_NAME}`;
    const path = `${directory}/${KEY_FILE_NAME}`;
    return {
      path,
      read: async () => {
        const saved = await files.readFile(path, "utf8").catch(() => null);
        const key = saved?.trim() ?? "";
        return key === "" ? null : key;
      },
      write: async (key: string) => {
        await files.mkdir(directory, { recursive: true });
        await files.writeFile(path, key, { mode: 0o600 });
      },
    };
  } catch {
    return null;
  }
};
