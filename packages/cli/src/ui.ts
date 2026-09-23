import pkg from "../package.json";

const enabled = (stream: NodeJS.WriteStream) => stream.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (open: string) => (text: string) => (enabled(process.stderr) ? `\x1b[${open}m${text}\x1b[0m` : text);

const truecolor = process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";

const color = (hex: string, layer: 38 | 48) => {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  if (truecolor) return `${layer};2;${r};${g};${b}`;
  const cube = (value = 0) => (value < 48 ? 0 : value < 115 ? 1 : Math.floor((value - 35) / 40));
  return `${layer};5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}`;
};

const FOLDER = { tab: "#62b8f5", back: "#7ec8f8", front: "#3ba3f0", shade: "#2a8bdb" };

function folder() {
  const cells = (colors: string[], glyphs: string) => `\x1b[${colors.join(";")}m${glyphs}\x1b[0m`;
  return [
    cells([color(FOLDER.tab, 38), color(FOLDER.back, 48)], "▀▀") + cells([color(FOLDER.back, 38)], "▄▄▄"),
    cells([color(FOLDER.front, 38), color(FOLDER.shade, 48)], "▀▀▀▀▀"),
  ];
}

export const brand = paint(color("#29a9e0", 38));
export const bold = paint("1");
export const dim = paint("2");
export const green = paint("32");
export const red = paint("31");
export const yellow = paint("33");

export const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

export const ok = (text: string) => `${green("✓")} ${text}`;
export const fail = (text: string) => `${red("✗")} ${text}`;
export const dot = (good: boolean, text: string) => `${good ? green("●") : yellow("●")} ${text}`;

export function header(tagline = "Cloud storage for AI agents") {
  const name = `${bold(brand("agentfs"))} ${dim("cli")} ${dim(`v${pkg.version}`)}`;
  if (!enabled(process.stderr)) return ["", `  ${name}`, `  ${tagline}`, ""].join("\n");
  const [top, bottom] = folder();
  return ["", `  ${top}  ${name}`, `  ${bottom}  ${dim(tagline)}`, ""].join("\n");
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
