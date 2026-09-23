import pkg from "../package.json";

const enabled = (stream: NodeJS.WriteStream) => stream.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (open: string) => (text: string) => (enabled(process.stderr) ? `\x1b[${open}m${text}\x1b[0m` : text);

export const brand = paint(process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit" ? "38;2;41;169;224" : "38;5;38");
export const bold = paint("1");
export const dim = paint("2");
export const green = paint("32");
export const red = paint("31");
export const yellow = paint("33");

export const ok = (text: string) => `${green("✓")} ${text}`;
export const fail = (text: string) => `${red("✗")} ${text}`;
export const dot = (good: boolean, text: string) => `${good ? green("●") : yellow("●")} ${text}`;

export function header(tagline = "Cloud storage for AI agents") {
  return ["", `  ${brand("📁")} ${bold(brand("agentfs"))} ${dim("cli")} ${dim(`v${pkg.version}`)}`, `  ${dim(tagline)}`, ""].join("\n");
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(message: string) {
  const live = enabled(process.stderr);
  let frame = 0;
  let current = message;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clear = () => process.stderr.write("\r\x1b[K");
  const render = () => {
    clear();
    process.stderr.write(`${brand(FRAMES[frame] ?? "")} ${current}`);
    frame = (frame + 1) % FRAMES.length;
  };
  if (live) {
    render();
    timer = setInterval(render, 80);
  }
  const stop = (line?: string) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (live) clear();
    if (line && live) process.stderr.write(`${line}\n`);
  };
  return {
    update(next: string) {
      current = next;
    },
    succeed: (text = current) => stop(ok(text)),
    fail: (text = current) => stop(fail(text)),
    stop: () => stop(),
  };
}
