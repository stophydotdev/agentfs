# AgentFS

[![skills.sh](https://skills.sh/b/stophydotdev/agentfs)](https://skills.sh/stophydotdev/agentfs)

Developer tools for [AgentFS](https://agentfs.cloud), cloud storage for AI agents.

```text
packages/cli/     agentfs CLI, published to npm as "@agentfs/cli"
packages/sdk/  SDK, published to npm as "@agentfs/sdk"
skills/agentfs/   Agent skill
```

## Get started

```bash
curl -fsSL https://agentfs.cloud/install | bash
agentfs put ./report
```

No install: `npx -y @agentfs/cli@latest put ./report`.

The docs are at https://docs.agentfs.cloud: a quickstart, the concepts, guides for many agents, the CLI, the SDK and the HTTP API.

Switching from Turso's `agentfs-sdk`? Change one import to `@agentfs/sdk`. See [`packages/sdk`](packages/sdk/README.md).

## Development

```bash
bun install
bun test
bun run build
```
