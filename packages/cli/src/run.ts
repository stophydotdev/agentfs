import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { UsageError } from "./usage-error";

export const localFolder = (folder: string) => {
  const path = relative(process.cwd(), resolve(folder)).split(sep).join("/");
  if (path === "" || path.startsWith("..")) {
    throw new UsageError(`${folder} must be a folder inside the current directory`);
  }
  return path;
};

export const parentOf = (path: string) => {
  const parent = dirname(path);
  return parent === "." ? "" : parent;
};

const TIMED_OUT = 124;

export const exec = (command: string[], timeoutSeconds: number | undefined) =>
  new Promise<number>((done) => {
    const [program = "", ...args] = command;
    const child = spawn(program, args, { stdio: "inherit" });
    let timedOut = false;
    const timer =
      timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutSeconds * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      process.stderr.write(`error: ${program}: ${error.message}\n`);
      done(127);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return done(TIMED_OUT);
      done(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  });
