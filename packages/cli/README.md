# agentfs CLI

Upload files from the terminal or from an agent, and get links anyone can open.

```bash
npx -y @agentfs/cli put ./report --to runs/42
```

```text
Signed up. Your key is in ~/.config/agentfs-next/key
https://agentfs.cloud/7d15d3b6da0bb24edce25579533f7ce3/runs/42/report/index.html
https://agentfs.cloud/7d15d3b6da0bb24edce25579533f7ce3/runs/42/report/img/chart.png
2 uploaded in 0.23s
```

The first run signs up and saves a key. Run the same command after a change and only the
changed files are sent. Each file keeps its link.

## Commands

| Command | What it does |
|---|---|
| `put <file or folder>... [--to folder]` | Upload. Unchanged files and bytes the account already has are not sent. |
| `pull <folder> [into]` | Download a folder. Files you already have are skipped. |
| `ls [prefix] [--by agent]` | List files with their size, agent, commit and link. |
| `rm <path>...` | Delete files. Their links stop working. |
| `fork <folder> <new folder>` | Copy a folder without sending any bytes. |
| `limits [--cap 5GB]` | Show usage and limits, or set a storage cap. |
| `claim` | Print a link. The person who opens it signs in with GitHub and keeps the files. |
| `key rotate` | Replace your key. The old one stops working at once. |
| `mcp` | Print the MCP config for agents that cannot run commands. |
| `feedback <message>` | Tell the agentfs team what failed or was slow. |

Add `--json` to any command for one JSON object per line.

## What put skips

In a git repo, `put` uploads only what git tracks or would track, so `.gitignore` applies.
It also skips `.env` files, `*.pem` and `*.key` files and SSH keys, and says which ones.
Add `--include-secrets` to upload them anyway.

## Limits

Each account holds 10 GB. A file up to 90 MiB goes up in one request. Bigger files go up in
parts, in parallel, up to 879 GiB, and an interrupted upload resumes where it stopped.
Files of an unclaimed account are deleted 24 hours after the first upload. `agentfs limits`
shows the exact numbers and the deadline.

## Keys

The key lives in `~/.config/agentfs-next/key`. In CI or a cloud VM, set `AGENTFS_KEY`
instead. Every upload records which agent made it (Claude Code, Codex, Cursor, Gemini CLI or
OpenCode) and the git commit, if there is one. Set `AGENTFS_AGENT` to name the agent
yourself.
