import type { Project, StoredFile } from "./api";
import { bold, clean, dim, ok } from "./ui";

export type Output = {
  json: boolean;
  data: (value: unknown, human: () => string) => void;
  info: (line: string) => void;
};

export function createOutput(forceJson: boolean): Output {
  const json = forceJson || !process.stdout.isTTY;
  return {
    json,
    data: (value, human) => {
      process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
    },
    info: (line) => {
      if (!json) process.stderr.write(`${line}\n`);
    },
  };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const table = (rows: string[][]) => {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
  return rows
    .map((row, index) => {
      const line = row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
      return index === 0 ? dim(line) : line;
    })
    .join("\n");
};

export function fileLine(file: StoredFile) {
  return [
    ok(`${bold(clean(file.path))} ${dim(`${formatBytes(file.size_bytes)} · ${clean(file.visibility)}`)}`),
    `  ${file.url ? clean(file.url) : dim(`Private. Run agentfs share ${clean(file.id)} for a link.`)}`,
  ].join("\n");
}

export function filesTable(files: StoredFile[]) {
  if (files.length === 0) return dim("No files.");
  return table([
    ["ID", "PATH", "SIZE", "VISIBILITY", "CREATED"],
    ...files.map((file) => [clean(file.id), clean(file.path), formatBytes(file.size_bytes), clean(file.visibility), clean(file.created_at.slice(0, 10))]),
  ]);
}

export function projectsTable(projects: Project[]) {
  if (projects.length === 0) return dim("No projects.");
  return table([
    ["NAME", "FILES", "SIZE", "VISIBILITY"],
    ...projects.map((project) => [clean(project.name), String(project.file_count), formatBytes(project.size_bytes), clean(project.default_visibility)]),
  ]);
}
