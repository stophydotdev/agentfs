# AgentFS HTTP API

Upload files and get links with plain HTTP. Every example below runs as written.

```bash
export AGENTFS=http://127.0.0.1:8787
export KEY=$(curl -s -X POST $AGENTFS/v1/signup | jq -r .key)
```

Signing up needs nothing else. Send the key as `Authorization: Bearer $KEY` on every other
call. One address can sign up 10 times a minute.

## Upload a file

```bash
echo '<h1>run 42</h1>' > run.html
curl -X PUT $AGENTFS/v1/files/reports/run.html \
  -H "authorization: Bearer $KEY" \
  -H "x-sha256: $(sha256sum run.html | cut -d' ' -f1)" \
  --data-binary @run.html
```

The answer holds the file's `url`. Anyone with the link can open it. Uploading to the same
path again keeps the link. `x-sha256` is required, and bytes that do not match it return
`sha256_mismatch` with nothing stored. One request holds up to 90 MiB.

## Upload many files and send only new bytes

```bash
curl -X POST $AGENTFS/v1/files \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d "{\"files\":[{\"path\":\"copy/run.html\",\"sha256\":\"$(sha256sum run.html | cut -d' ' -f1)\",\"size\":15}]}"
```

Each file comes back with a `status`: `linked` (the account had these bytes, so the file now
exists), `unchanged`, `missing` (upload it with PUT) or `over_cap`. Send up to 1000 files per
call.

## Upload a big file in parts

```bash
head -c 6000000 /dev/urandom > big.bin
SHA=$(sha256sum big.bin | cut -d' ' -f1)
ID=$(curl -s -X POST $AGENTFS/v1/uploads -H "authorization: Bearer $KEY" \
  -d "{\"path\":\"big.bin\",\"sha256\":\"$SHA\",\"size\":6000000}" | jq -r .uploadId)
split -b 5242880 -d big.bin part.
P1=$(curl -s -X PUT $AGENTFS/v1/uploads/$SHA/$ID/1 -H "authorization: Bearer $KEY" --data-binary @part.00 | jq -r .etag)
P2=$(curl -s -X PUT $AGENTFS/v1/uploads/$SHA/$ID/2 -H "authorization: Bearer $KEY" --data-binary @part.01 | jq -r .etag)
curl -X POST $AGENTFS/v1/uploads/$SHA/$ID/complete -H "authorization: Bearer $KEY" \
  -d "{\"path\":\"big.bin\",\"parts\":[{\"partNumber\":1,\"etag\":\"$P1\"},{\"partNumber\":2,\"etag\":\"$P2\"}]}"
```

Every part but the last must be the same size and at least 5 MiB. The start answer suggests
`partBytes`, 90 MiB. An upload holds up to 10,000 parts.

## List files

```bash
curl "$AGENTFS/v1/files?prefix=reports/" -H "authorization: Bearer $KEY"
```

Each file has its `path`, `size`, `sha256`, `contentType`, the `agent`, `session` and `commit`
that made it, and its `url`. A page holds 1000 files. When `cursor` is not null, send it back
as `?cursor=` for the next page.

## Open a link

```bash
curl -H "range: bytes=0-3" $(curl -s "$AGENTFS/v1/files?prefix=reports/" -H "authorization: Bearer $KEY" | jq -r '.files[0].url')
```

Links need no key. They answer `Range` requests, so videos can seek, and send the file's
sha256 as the `ETag`. A deleted file's link returns 404.

## Copy a folder

```bash
curl -X POST $AGENTFS/v1/fork -H "authorization: Bearer $KEY" \
  -d '{"from":"reports","to":"reports-copy"}'
```

The copy points at the same bytes, so it is instant and uses no storage. The two folders
cannot sit inside each other.

## Delete a file

```bash
curl -X DELETE $AGENTFS/v1/files/reports-copy/run.html -H "authorization: Bearer $KEY"
```

Returns 204, even when the file was already gone. Its storage is freed at once.

## Read and set limits

```bash
curl $AGENTFS/v1/limits -H "authorization: Bearer $KEY"
curl -X PUT $AGENTFS/v1/limits -H "authorization: Bearer $KEY" -d '{"capBytes":5000000000}'
```

You get `usedBytes`, `files`, `capBytes`, `owner`, `expiresAt` and the size limits. Each
account holds up to 10 GB. Set a lower cap to stop a runaway loop. An upload past the cap
returns `storage_cap_reached`.

## Keep the files: claim the account

```bash
curl -X POST $AGENTFS/v1/claim -H "authorization: Bearer $KEY"
```

Give the `url` to a person. It works for one hour. They sign in with GitHub and the account
is theirs. Until then, `expiresAt` says when the files are deleted: 24 hours after the first
upload. The key stops working at the same time.

## Rotate the key

```bash
NEW=$(curl -s -X POST $AGENTFS/v1/keys/rotate -H "authorization: Bearer $KEY" | jq -r .key)
```

The old key returns `key_revoked` from then on.

## Send feedback

```bash
curl -X POST $AGENTFS/v1/feedback -H "authorization: Bearer $NEW" \
  -d '{"message":"uploads over 1 GB are slow from us-east"}'
```

Up to 5 a minute and 30 a day. Past that you get `feedback_rate_limited` with `retryAfter`.

## Say which agent made a file

Send `x-agentfs-agent`, `x-agentfs-session` and `x-agentfs-commit` with an upload. The list
shows them, so you can find what each agent made.

## Use it over MCP

```bash
curl -X POST $AGENTFS/mcp -H "authorization: Bearer $NEW" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Point an MCP client at `$AGENTFS/mcp` with the same header. The tools are `upload_file`,
`list_files`, `delete_file`, `fork_folder`, `get_limits`, `send_feedback` and `claim_account`.

## Errors

Every error looks like this:

```json
{ "error": { "code": "storage_cap_reached", "message": "This account reached its storage cap. Delete files, or raise the cap with PUT /v1/limits.", "retryAfter": null } }
```

The message says what to do next. `retryAfter`, when it is set, is in seconds and matches the
`Retry-After` header.
