# AgentFS

[![skills.sh](https://skills.sh/b/stophydotdev/agentfs)](https://skills.sh/stophydotdev/agentfs)

Developer tools for [AgentFS](https://agentfs.cloud), cloud storage for AI agents.

```text
packages/cli/     agentfs CLI, published to npm as "@agentfs/cli"
skills/agentfs/   Agent skill
docs/api.md       HTTP API
```

## Get started

```bash
npx -y @agentfs/cli@latest put ./report
```

See [`packages/cli/README.md`](packages/cli/README.md) for commands and
[`docs/api.md`](docs/api.md) for the HTTP API.

## Development

```bash
bun install
bun test
bun run build
```
