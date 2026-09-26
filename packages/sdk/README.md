# @agentfs/sdk

File storage for apps and agents on [AgentFS](https://agentfs.cloud). The API matches `@upstash/blob`: a `Bucket` on the server, direct uploads from the browser, and a React hook.

```bash
npm install @agentfs/sdk
```

```ts
import { Bucket, uniquePath } from "@agentfs/sdk";

const bucket = Bucket.fromEnv(); // AGENTFS_TOKEN, and AGENTFS_BUCKET or the key's default project

const blob = await bucket.put(uniquePath`avatars/${file.name}`, file, { contentType: "image/png" });
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

Bodies over 1 MB go straight to storage; over 16 MB they go up in parts, several at a time, with retries per part. `allowOverwrite: false` and `ifUnchanged` work up to 5 GB. A stream needs `size` or `maxSize` unless it is 1 MB or less.

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
const upload = await bucket.signedUploadUrl("inbox/scan.pdf", { contentType: "application/pdf" });
await fetch(upload.url, { method: "PUT", headers: upload.headers, body: file });
```

## Browser uploads

Mount one route in your app. It checks who may upload and where the file goes; the browser sends the bytes straight to storage and never sees your key.

```ts
// app/api/upload/route.ts
import { Bucket, uniquePath, uploadHandler } from "@agentfs/sdk";

export const uploads = uploadHandler({
  bucket: Bucket.fromEnv(),
  constraints: { maxSize: "20mb", contentTypes: ["image/*", "application/pdf"] },
  context: (request) => requireUser(request),
  onBeforeUpload: ({ ctx, file }) => ({ path: uniquePath`${ctx.id}/${file.name}`, metadata: { owner: ctx.id } }),
  onUploadComplete: ({ ctx, path, url }) => db.files.insert({ owner: ctx.id, path, url }),
});

export const { GET, POST } = uploads;
```

`GET` serves the route's constraints. `POST` runs the upload in phases: `begin` checks the file (size, type and its first bytes) and calls `onBeforeUpload`, `parts` hands out part URLs, `end` records the file and returns what `onUploadComplete` returns, `cancel` aborts. `routes` mounts several named routes on one endpoint (`?route=avatar`), each inheriting the top-level options; `proxy: true` sends the bytes through your server instead. `uploadRoute<Ctx>()({ input, ... })` types a route's input and data.

```ts
// browser
import { upload } from "@agentfs/sdk/browser";

const task = upload(file, { route: "/api/upload" });
task.subscribe(() => console.log(task.snapshot().percent));
task.pause();
task.resume();
const blob = await task.done; // blob.data is what onUploadComplete returned
```

Files over 16 MB go up in parallel parts with retries, pause and resume, and pick up where they left off after a reload when the user chooses the same file again.

```tsx
// React
import { uploadHooks } from "@agentfs/sdk/react";
import type { uploads } from "./api/upload/route";

export const { useUpload } = uploadHooks<typeof uploads>();

const avatar = useUpload();
// <input type="file" accept={avatar.accept} onChange={(e) => avatar.start({ file: e.target.files![0] })} />
// avatar.upload?.status, .percent, .stalled, .blob?.data, .error, .pause(), .resume(), .cancel(), .retry()
```

`start({ files })` queues several at once; three upload at a time by default (`concurrency`). Files over the route's `maxSize` or outside its `contentTypes` fail before any request. `useServerUpload(url)` posts the file as FormData to a route of your own and reports progress.

Route names and completion data are checked at compile time. Uploads from other sites must come from an origin in the project's allowed origins.

## Multipart housekeeping

```ts
await bucket.listMultipartUploads({ prefix: "uploads/" });
await bucket.abortMultipartUpload({ uploadId });
await bucket.abortStaleMultipartUploads({ olderThan: "1d" });
```

## S3 clients

Buckets speak the S3 API, so the AWS SDK, the AWS CLI and other S3 tools work too. `bucket.s3()` gives the AWS SDK an endpoint and credentials that refresh themselves:

```ts
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const config = bucket.s3();
const s3 = new S3Client(config);
await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: "reports/q3.pdf" }));
```

Keys are the same paths `put` writes, so both see the same files. One `PutObject` takes up to 100 MB; larger objects go up with multipart, which `@aws-sdk/lib-storage` and the AWS CLI do on their own. Use it for what the SDK doesn't wrap, like byte ranges.

## Errors

Every failure throws a `BlobError` with a `code`: `not_found`, `already_exists`, `conflict`, `content_type_not_allowed`, `invalid_content_type_pattern`, `invalid_input`, `too_large`, `empty_body`, `length_required`, `signature_mismatch`, `unauthorized`, `forbidden`, `rate_limited`, `mint_backoff`, `not_ready`, `partial_delete`, `move_left_a_copy` or `request_failed`. Reads, writes, copies and deletes that fail with `429`, `5xx` or a dropped connection are tried up to 3 times with jittered backoff, honoring `Retry-After` up to 10 seconds. Streamed bodies are sent once.

```ts
import { BlobError } from "@agentfs/sdk";

try {
  await bucket.put(path, body, { allowOverwrite: false });
} catch (error) {
  if (BlobError.is(error) && error.code === "already_exists") return;
  throw error;
}
```
