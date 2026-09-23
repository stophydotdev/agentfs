# AgentFS

Developer tools for [AgentFS](https://agentfs.cloud), cloud storage for AI agents.

The hosted AgentFS application lives in [`stophydotdev/agentfs-app`](https://github.com/stophydotdev/agentfs-app).

## Repository layout

```text
agentfs/
├── packages/
│   └── cli/       # agentfs CLI, published to npm as "agentfs"
├── skills/
│   └── agentfs/   # Agent skill, bundled into the CLI and installed by `agentfs setup`
└── README.md
```

## CLI

```bash
npm install -g agentfs
agentfs login
agentfs upload ./report.pdf
agentfs setup
```

See [`packages/cli/README.md`](packages/cli/README.md) for every command.

## Development

```bash
bun install
bun run --cwd packages/cli dev -- status
bun test
bun run build
```

`AGENTFS_API_URL=http://localhost:3000` points the CLI at a local `agentfs-app` dev server.

## Status

The CLI and the agent skill work against the REST API. A TypeScript SDK is not built yet.
