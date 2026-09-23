# @agentfs/sdk

Upload files to [AgentFS](https://agentfs.cloud) and get a link, from any runtime with `fetch`: Node 20+, Bun, Deno, Cloudflare Workers and browsers.

```bash
npm install @agentfs/sdk
```

```ts
import { createAgentFS } from "@agentfs/sdk";

const agentfs = createAgentFS({ apiKey: process.env.AGENTFS_API_KEY });

const file = await agentfs.put("reports/q3.pdf", pdfBytes, { visibility: "private" });
const { url } = await agentfs.accessUrl(file.id, { expiresIn: "24h" });
```

Without an `apiKey`, `put` uploads without an account: the file is unlisted, up to 100 MB, and deleted after 24 hours.

## Uploads

`put(path, body, options)` takes a `Blob`, `ArrayBuffer`, `Uint8Array` or string. `path` is `project/folder/name`; a bare name goes to the key's default project.

Large files go up in parts, several at a time. A failed part is retried with backoff (`408`, `429` and `5xx`, honoring `Retry-After`), and an expired part URL is fetched again. Pass `onProgress` to follow along and `signal` to cancel.

| Option | Meaning |
| --- | --- |
| `contentType` | Media type. Defaults to the body's type. |
| `visibility` | `public`, `unlisted` or `private`. |
| `expiresIn` | Delete the file after a duration such as `24h` or `7d`. |
| `label` | Display label. |
| `replace` | Overwrite the file at `path`, keeping its ID and URL. Up to 100 MB. |
| `multipart` | Force a resumable upload in parts at any size. |
| `idempotencyKey` | Makes a small upload safe to retry. |
| `onProgress` | `(uploadedBytes, totalBytes) => void` |
| `signal` | `AbortSignal` |

## Files

```ts
await agentfs.get(id);
await agentfs.list({ project: "reports", runId: "run_42", limit: 50 });
const response = await agentfs.read(id);
await agentfs.rename(id, "final.pdf");
await agentfs.delete(id);
await agentfs.restore(id);
await agentfs.delete(id, { permanent: true });
```

## Links

```ts
await agentfs.accessUrl(id, { expiresIn: "1h" });
await agentfs.revokeAccess(id);
```

`revokeAccess` stops every private link issued for that file so far.

## Account

```ts
const { plan, usage } = await agentfs.account();
usage?.remaining_bytes;
```

## Errors

Failed requests throw `AgentFSError` with `status`, `code`, `retryable` and `retryAfterSeconds`. The codes are listed at [docs.agentfs.cloud/errors](https://docs.agentfs.cloud/errors).

## Options

`createAgentFS({ apiKey, baseUrl, fetch, runId, agentId, concurrency, multipartThreshold, retry })`. `runId` and `agentId` tag every file this client writes, so you can list them later.
