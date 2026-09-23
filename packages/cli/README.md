# agentfs

Cloud storage for AI agents, from the terminal. Upload a file, get a link.

```bash
npm install -g agentfs
agentfs login
agentfs upload ./report.pdf
```

```
reports/report.pdf  2.3 MB  unlisted
https://f.agentfs.cloud/f/f_8f2c
```

## Give your agents AgentFS

```bash
agentfs setup
```

This installs the `agentfs` skill for Claude Code (`~/.claude/skills`) and for agents that read `~/.agents/skills` (Codex, Cursor, OpenCode and others), and adds the hosted MCP server to Claude Code, Cursor and OpenCode. Pass `--local` to install the skill into the current project instead, `skills` or `mcp` to do one part, and `--remove` to undo.

## Commands

| Command | What it does |
| --- | --- |
| `agentfs login` | Log in with your browser. `--api-key afs_...` saves a key instead. |
| `agentfs logout` | Remove the saved key. |
| `agentfs status` | Version, login and account. Same as `agentfs --status`. |
| `agentfs upload <file...>` | Upload files. `--project`, `--path`, `--prefix`, `--visibility`, `--expires-in`, `--replace`, `--run-id`. |
| `agentfs ls` | List files. `--project`, `--prefix`, `--path`, `--query`, `--run-id`, `--limit`, `--cursor`. |
| `agentfs get <id>` | Show one file. |
| `agentfs download <id>` | Download a file. `-o` sets the path. |
| `agentfs mv <id> <name>` | Rename a file. The id and link stay the same. |
| `agentfs rm <id...>` | Move to the trash. `--permanent` deletes now. |
| `agentfs share <id>` | Time-limited link for a private file. `--expires-in 1h`. |
| `agentfs projects` | List projects. `create <name>`, `rm <name>`. |
| `agentfs env` | Write `AGENTFS_KEY` into `.env`. |
| `agentfs setup` | Install the skill and MCP server into your agents. |

Files up to 100 MiB upload in one request. Larger files use a resumable session that sends parts straight to storage.

## Output

On a terminal the output is short and readable. When piped, or with `--json`, every command prints JSON, and failures print `{ "success": false, "error": { "code", "message" } }` with exit code 1.

## Configuration

The key is read from `--api-key`, then `AGENTFS_KEY`, then `~/.config/agentfs/config.json` (written by `agentfs login`, readable only by you). Set `NO_COLOR=1` to turn colors off.

## Development

```bash
bun install
bun run dev -- status
bun test
bun run build
```

`AGENTFS_API_URL=http://localhost:3000` points the CLI at a local `agentfs-app` dev server.
