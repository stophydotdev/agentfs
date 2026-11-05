# @agentfs/sdk

Switch from Turso's `agentfs-sdk` by changing one line. Your agent's files, key-value store and tool calls then live in the agentfs cloud.

```diff
- import { AgentFS } from "agentfs-sdk";
+ import { AgentFS } from "@agentfs/sdk";
```

```bash
npm install @agentfs/sdk
```

```ts
import { AgentFS } from "@agentfs/sdk";

const agent = await AgentFS.open({ id: "my-agent" });

await agent.kv.set("user:preferences", { theme: "dark" });
const prefs = await agent.kv.get("user:preferences");

await agent.fs.writeFile("/output/report.pdf", pdfBuffer);
const files = await agent.fs.readdir("/output");

await agent.tools.record("web_search", Date.now() / 1000, Date.now() / 1000 + 1.5, { query: "AI" }, { results: [] });
```

`id: "my-agent"` becomes the folder `my-agent/`. Every path, key and snapshot of this agent stays inside it.

## Open

```ts
const agent = await AgentFS.open({ key, url, prefix: "runs/42/" });
```

| Option | Default |
|---|---|
| `key` | `AGENTFS_KEY`, then the key file of the agentfs CLI, then a new account (the key is saved to that file). |
| `url` | `AGENTFS_URL`, then `https://agentfs.cloud`. |
| `prefix` | `""`. A folder that roots every path: with `prefix: "runs/42/"`, `/a.txt` is `runs/42/a.txt`. |
| `id` | Same as `prefix`, for code written for Turso. `prefix` wins when both are set. |
| `path` | Accepted and ignored. There is no database file. |
| `agent` | A name for this agent, sent as `x-agentfs-agent` on writes, so the timeline and usage show who wrote. 1 to 128 letters, digits and `. : @ / - _`. |

Where there is no file system (Workers, browsers), pass `key` or set the variable. Nothing is read or written on disk there.

Every request carries `User-Agent: agentfs-sdk/<version>`, except in browsers, which do not allow it.

## agent.fs

`stat`, `lstat`, `readFile`, `writeFile`, `readdir`, `readdirPlus`, `mkdir`, `rmdir`, `unlink`, `rm`, `rename`, `copyFile`, `access`, `statfs` and `open` have Turso's signatures. A leading `/` is allowed.

- `mkdir` succeeds and sends nothing. Folders exist when a file is under them.
- `copyFile` links the same bytes. Nothing is uploaded again.
- A big write goes up in parts, on every plan. The biggest file depends on the plan, and a bigger one fails with `file_too_large`. See https://docs.agentfs.cloud/reference/limits.
- `readFile(path)` returns a `Buffer`. Where there is no `Buffer`, pass an encoding, or call `readBytes(path)` for a `Uint8Array`.
- `open(path)` gives a handle. `pread` reads a byte range. `pwrite` and `truncate` rewrite the whole file.
- `symlink` and `readlink` throw `ENOSYS`.
- `stat` has no owner or permission data: `uid` and `gid` are 0, a file is `0o644` and a folder `0o755`.

Extras: `exists(path)`, `readBytes(path)` and `link(path)`, which returns the public URL.

`writeFile(path, data, { private: true })` uploads a file with no public link, and `{ private: false }` makes it public. Leave `private` out and a file keeps what it has. `readFile` reads a private file with your key. `link(path)` throws `EPERM` for a private file. `signedUrl(path, { ttlSeconds })` returns `{ url, expiresAt }`: a link that opens the file with no key, for 300 seconds by default and at most 3600.

## agent.kv

`get`, `set`, `delete` and `list(prefix)` store JSON up to 64 KB. Keys are 1 to 512 characters of letters, digits and `_ . : @ / -`. The `prefix` option applies to keys too.

## agent.tools

`record(name, started_at, completed_at, parameters?, result?, error?)` has Turso's signature, with times in seconds, and returns a numeric id. `get(id)`, `getByName(name, limit?)` and `getRecent(since, limit?)` read calls back. An `error` is kept as `{ error }` in the call's output.

`start`, `success`, `error` and `getStats` are not supported.

## Cloud extras

```ts
await agent.snapshot("before", "/");
const changes = await agent.diff("before");
await agent.restore("before");
const url = await agent.fs.link("/output/report.pdf");
```

`snapshot(name, folder?)` saves a folder. `diff(from, to?)` compares two snapshots, or one with the current files. `restore(name)` makes the folder match the snapshot again and deletes files that are not in it. Paths in the answers are account paths, so they include `prefix`.

## Errors

Every failure is an `AgentFSError`. Its `code` is a Turso code where one fits: `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EPERM`, `EINVAL` or `ENOSYS`. Otherwise it is the agentfs code, such as `storage_cap_reached`. `agentfsCode`, `requestId`, `status`, `retryAfter`, `syscall` and `path` are on the error too.

```ts
try {
  await agent.fs.readFile("/missing.txt");
} catch (error) {
  if (error instanceof AgentFSError && error.code === "ENOENT") console.log(error.requestId);
}
```

## Where it runs

Node 20.12 and newer, Bun, Deno and Workers. It needs `fetch` and Web Crypto, and has no dependencies. The key file is read through a dynamic import, only where a file system exists.

## Docs

https://docs.agentfs.cloud/reference/sdk
