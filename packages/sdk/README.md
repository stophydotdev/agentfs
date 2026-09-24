# @agentfs/sdk

File storage for apps and agents on [AgentFS](https://agentfs.cloud). The API matches `@upstash/blob`: a `Bucket` on the server, direct uploads from the browser, and a React hook.

```bash
npm install @agentfs/sdk
```

```ts
import { Bucket } from "@agentfs/sdk";

const bucket = Bucket.fromEnv(); // AGENTFS_TOKEN, and AGENTFS_BUCKET or the key's default project

const blob = await bucket.put("avatars/me.png", file, { contentType: "image/png" });
blob.url;          // served at its path
blob.versionedUrl; // url + ?v=<etag>, changes when the bytes do

await bucket.get("avatars/me.png");  // record + ReadableStream body
await bucket.info("avatars/me.png"); // record only
await bucket.exists("avatars/me.png");
await bucket.list({ prefix: "avatars/", limit: 100 });
await bucket.del("avatars/me.png");
```

A bucket is an AgentFS project. `new Bucket({ token, bucket: "site" })` picks one; without `bucket`, the key's default project is used. Visibility belongs to the bucket: public buckets give every file a `url`, private ones need `signedReadUrl`.

## Writing

`put(path, body, options)` takes a `Blob`, `File`, `ArrayBuffer`, typed array, string, `ReadableStream` or `Request`. It overwrites by default.

| Option | Default | What it does |
| --- | --- | --- |
| `contentType` | the body's, else `application/octet-stream` | Stored type |
| `contentTypes` | any | Allow list, like `["image/*", "application/pdf"]` |
| `maxSize` | none | Refuse a bigger body with `too_large` |
| `cache` | bucket default | `immutable`, `revalidate`, `no-store` or a duration like `1h` |
| `metadata` | none | Lowercase keys, printable ASCII values |
| `allowOverwrite` | `true` | `false` fails with `already_exists` if a file is there |
| `ifUnchanged` | none | An etag; fails with `conflict` if the file changed |
| `multipart` | `"16mb"` | Size above which the body goes up in parts; `true` or `false` forces it |

Bodies over 16 MB go up in parts, several at a time, with retries per part. `allowOverwrite: false` and `ifUnchanged` work up to 100 MB.

```ts
await bucket.copy("tmp/9f3c", "archive/report.pdf");
await bucket.move("tmp/9f3c", "reports/q3.pdf");
await bucket.updateJson<{ n: number }>("count.json", (prev) => ({ n: (prev?.n ?? 0) + 1 }));
await bucket.del(["a.png", "b.png"]);
await bucket.del({ prefix: "tmp/" });
```

## Links

```ts
await bucket.publicUrl("avatars/me.png");
const { url, expiresAt } = await bucket.signedReadUrl("reports/q3.pdf", { expiresIn: "2m", downloadAs: "Report Q3.pdf" });
const upload = await bucket.signedUploadUrl("inbox/scan.pdf", { size: file.size, contentType: "application/pdf" });
await fetch(upload.url, { method: "PUT", headers: upload.headers, body: file });
```

## Browser uploads

Your server mints a short-lived upload token for one path. The browser sends the bytes straight to AgentFS and never sees your key.

```ts
// server
const { token, path } = await bucket.uploadToken({
  path: `avatars/${user.id}.png`,
  maxSize: "2mb",
  contentTypes: ["image/*"],
  callbackUrl: "https://example.com/api/agentfs", // optional
});
```

```ts
// browser
import { upload } from "@agentfs/sdk/browser";

const task = upload(file, { token, path, onProgress: (sent, total) => {} });
const blob = await task.done;
```

```tsx
// React
import { useUpload } from "@agentfs/sdk/react";

const avatar = useUpload({ getTarget: (file) => fetch("/api/upload-token", { method: "POST" }).then((r) => r.json()) });
// avatar.start(file), avatar.status, avatar.percent, avatar.blob, avatar.error, avatar.cancel()
```

With `callbackUrl`, AgentFS posts `upload.completed` when the file is stored. Check it with the `callbackSecret` from `uploadToken`:

```ts
import { verifyUploadCallback } from "@agentfs/sdk";

const event = await verifyUploadCallback(secret, request.headers.get("agentfs-signature"), await request.text());
if (event) await db.files.insert({ path: event.data.file.path });
```

## Multipart housekeeping

```ts
await bucket.listMultipartUploads({ prefix: "uploads/" });
await bucket.abortMultipartUpload({ uploadId });
await bucket.abortStaleMultipartUploads({ olderThan: "1d" });
```

## Errors

Every failure throws a `BlobError` with a `code`: `not_found`, `already_exists`, `conflict`, `content_type_not_allowed`, `invalid_input`, `too_large`, `length_required`, `unauthorized`, `forbidden`, `rate_limited`, `move_left_a_copy` or `request_failed`. Retryable failures (`408`, `429`, `5xx`) are retried with backoff first, honoring `Retry-After`.

```ts
import { BlobError } from "@agentfs/sdk";

try {
  await bucket.put(path, body, { allowOverwrite: false });
} catch (error) {
  if (BlobError.is(error) && error.code === "already_exists") return;
  throw error;
}
```
