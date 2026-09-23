# agentfs

Cloud storage for AI agents. Upload a file, get a link.

## Get started

```bash
npx -y @agentfs/cli@latest init --all --browser
```

This installs the CLI, logs you in, and teaches your AI agents to use AgentFS.

Only want the agent skill?

```bash
npx skills add stophydotdev/agentfs
```

## Use it

```bash
agentfs upload report.pdf                      # get a link
agentfs upload data.csv --visibility private   # keep it private
agentfs share <id> --expires-in 1h             # link that expires
agentfs ls                                     # your files
agentfs download <id>                          # get a file back
```

Or ask your agent: "Upload report.pdf and give me a link."

## Commands

| Command | |
| --- | --- |
| `init` | Set up everything in one go |
| `login` / `logout` | Log in with your browser, or log out |
| `status` | Show your account |
| `upload <file...>` | Upload files and get links |
| `ls` | List your files |
| `get <id>` | Show one file |
| `download <id>` | Download a file |
| `share <id>` | Link to a private file |
| `mv <id> <name>` | Rename a file |
| `rm <id...>` | Delete files |
| `projects` | List or create projects |
| `config` | Show where your login is saved |
| `setup` | Add AgentFS to your AI agents |

`upload` also works before `login`, for a quick share: files up to 100 MB, unlisted, with links that expire in 24 hours. Log in to keep files.

Run `agentfs <command> --help` for options. Add `--json` to any command for JSON output.

## Links

- [agentfs.cloud](https://agentfs.cloud)
- [Docs](https://docs.agentfs.cloud)
