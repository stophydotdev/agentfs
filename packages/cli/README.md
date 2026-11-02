# agentfs CLI

Upload files from the terminal or from an agent, and get links anyone can open.

```bash
curl -fsSL https://agentfs.cloud/install | bash
agentfs put ./report --to runs/42
```

No install: `npx -y @agentfs/cli put ./report --to runs/42`.

```text
Signed up. Your key is in ~/.config/agentfs/key
https://agentfs.cloud/7d15d3b6da0bb24edce25579533f7ce3/runs/42/report/index.html
https://agentfs.cloud/7d15d3b6da0bb24edce25579533f7ce3/runs/42/report/img/chart.png
2 uploaded in 0.23s
```

The first run signs up and saves a key. Run the same command after a change and only the changed files are sent. Each file keeps its link.

Unclaimed accounts hold 1 GB for 24 hours. Run `agentfs claim` and give the link to a person: they sign in with GitHub and get 10 GB free.

## Commands

Run `agentfs <command> --help` for the options.

| Command | What it does |
|---|---|
| `put`, `pull` | Upload and download files and folders. |
| `ls`, `stat`, `mv`, `rm`, `undelete`, `fork` | List, inspect, move, delete, bring back and copy. |
| `sync <dir> <folder> [--watch]` | Mirror a local folder and a remote folder both ways. |
| `run [--in folder]... [--out folder]... -- <command>` | Pull inputs, run a command, push outputs. |
| `snapshot`, `restore`, `diff` | Save a folder, put it back, compare. |
| `timeline`, `usage`, `log` | See what was written, add it up, record a tool call. |
| `kv get`, `kv set`, `kv rm`, `kv ls` | Key-value store, with compare-and-swap and locks. |
| `status`, `limits`, `claim` | Key and usage, limits, keep the account. |
| `login --key-stdin`, `logout` | Save or delete a key. |
| `key create`, `key list`, `key revoke`, `key rotate` | Keys for sub-agents, and replacing yours. |
| `import`, `export` | Move data to and from a Turso AgentFS database. |
| `mcp`, `feedback`, `report` | MCP config, feedback, report a link. |

When stdout is not a terminal, every command prints one JSON object per line. `--no-json` forces text, `--json` forces JSON.

Exit codes: 1 an error, 2 a usage error, 3 a conflict (`put`, `sync`), 124 a timeout (`run`).

## What put skips

In a git repo, `put` uploads only what git tracks or would track, so `.gitignore` applies. It also skips `.env` files, `*.pem` and `*.key` files and SSH keys, and says which ones. Add `--include-secrets` to upload them anyway.

## Keys

The key lives in `~/.config/agentfs/key`. In CI or a cloud VM, set `AGENTFS_KEY` instead. Every upload records which agent made it (Claude Code, Codex, Cursor, Gemini CLI or OpenCode) and the git commit, if there is one. Set `AGENTFS_AGENT` to name the agent yourself.

## Docs

Every command, with examples, is in the docs: https://docs.agentfs.cloud
