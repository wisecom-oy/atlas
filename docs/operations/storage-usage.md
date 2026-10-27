---
description: Measure how many bytes an Atlas tenant bucket holds with atlas stats storage, including object versions, delete markers, and incomplete uploads.
---

# Storage usage

`atlas stats storage` reports how many bytes the tenant bucket physically holds. That includes every version kept by versioning or Object Lock, delete markers, staging objects, and incomplete multipart uploads. It works on any S3-compatible backend, because it reads the bucket listing rather than provider metrics.

```bash
atlas stats storage                                    # totals and per-workload breakdown
atlas stats storage --by owner --top 10                # the ten owners and sites holding the most bytes
atlas stats storage --target-config ./replica.json     # the replica bucket
```

The SDK returns the same report from [`getStorageUsage()`](/reference/sdk#storage-usage).

| Option                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `--by <breakdown>`      | `workload` (default) or `owner`.                                            |
| `--top <n>`             | Rows to show for `--by owner`. Default `20`.                                |
| `--json`                | Print the report as JSON. Includes `complete`, `continuation_token`, `versions_visible`, and `measured_at`. |
| `--max-requests <n>`    | Stop after `n` S3 requests and print a continuation token.                  |
| `--continue <token>`    | Resume a run from its continuation token.                                   |
| `--target-endpoint <url>`, `--target-access-key <key>`, `--target-secret-key <key>`, `--target-region <region>` | Measure a replica instead of the primary. Use `-` as the secret key to read it from stdin. |
| `--target-config <path>` | JSON file with the replica's S3 credentials.                              |

## Logical and physical sizes

Atlas reports two sizes that answer different questions:

| Size     | Where                                                                                              | Measures                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Logical  | `atlas stats`, `total_size_bytes` in mailbox, drive, and site statistics, and snapshot summaries | The items as Microsoft 365 reports them, summed across every snapshot.                                  |
| Physical | `atlas stats storage`, `getStorageUsage()`                                                          | What the bucket holds, including retained versions and incomplete uploads. This is what a provider bills. |

Deduplication keeps physical size below logical size, because one stored object serves every snapshot that references it. Other factors push physical size up: base64 encoding in MIME adds about 33% to attachments, each object carries encryption overhead, noncurrent versions stay until they expire, and legacy index objects and staging leftovers take up space that the manifests do not reference.

A complete report includes `logical_bytes_referenced`, so you can compare the two figures in one place. Reading the manifests requires the tenant's data key. A bucket with no backups, or a replica without the key, returns the physical report only.

## Categories

| Category             | Counts                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `current`            | The latest version of each live object.                                                                                                  |
| `noncurrent`         | Older versions kept by versioning or Object Lock. Buckets created by Atlas expire noncurrent versions after 30 days. Retention can keep them longer. |
| `delete_markers`     | Delete markers. They hold no bytes. Atlas's lifecycle rules remove them once nothing remains behind them.                              |
| `staging`            | Objects under `onedrive/staging/` and `sharepoint/staging/`. Already included in `current` or `noncurrent`. A large value usually means abandoned large-file uploads. |
| `incomplete_uploads` | Multipart uploads that were never completed or aborted, and the bytes their parts hold. Not in `current`, but most providers bill for them. |

`stored_bytes` is `current` + `noncurrent` + `incomplete_uploads`. The workload breakdown follows the [storage layout](/operations/storage-layout): `outlook` (`data/`, `attachments/`, `manifests/`), `onedrive`, `sharepoint`, `meta` (`_meta/`), and `other` (any key outside the layout). The rows add up to the totals. With `--by owner`, each row is one mailbox, OneDrive owner, or SharePoint site, identified by the opaque ID in its key.

## Request cost

The report lists every object, so it is exact. Listing costs requests:

- One `ListObjectVersions` request per 1,000 versions.
- One `ListMultipartUploads` request per 100 incomplete uploads.
- One or more `ListParts` requests per incomplete upload, at 1,000 parts per request.

A tenant with two million stored versions needs about 2,000 list requests per run. Providers such as AWS bill list requests at the PUT rate, so compare that count with how often you schedule the report. The `list_requests` field in the output gives the exact count for each run.

Memory use stays flat as object count grows. Pages are counted and then discarded. `--by owner` grows with the number of owners and sites, not with the number of objects.

## Split a long run

For large buckets, cap the requests per run and resume:

```bash
atlas stats storage --max-requests 1000 --json > part1.json
atlas stats storage --max-requests 1000 --continue "$(jq -r .continuation_token part1.json)"
```

`--max-requests` counts every request, including the one that sizes an incomplete upload, so a run never exceeds the limit. Resuming continues from the last counted position. Each object is counted once. If the bucket changes between runs, objects written or deleted after the cursor can make the final totals differ from a single uninterrupted run.

If a request fails after the SDK's own retries, such as a `503 SlowDown` or a dropped connection, the run stops and keeps its progress. The CLI prints the continuation token to stderr. In the SDK, `getStorageUsageToken(err)` returns it. Resuming repeats only the failed page.

::: warning Continuation tokens are sensitive
A token is valid only for the tenant, target, and breakdown it was issued for. It is base64url-encoded JSON, not encrypted. It contains the tenant ID, the counts so far, and a listing position that embeds a mailbox, owner, or site ID. Treat it like the report itself, and keep it out of shared logs and tickets.
:::

## Permissions

| S3 action                       | Used for                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `s3:ListBucket`                 | Live objects.                                                                                                                             |
| `s3:ListBucketVersions`         | Noncurrent versions and delete markers. Without it, the report counts live objects only and sets `versions_visible: false`.              |
| `s3:ListBucketMultipartUploads` | Incomplete uploads. Without it, the report sets `incomplete_uploads_visible: false` rather than reporting zero.                           |
| `s3:ListMultipartUploadParts`   | Sizing each incomplete upload. Without it, uploads are counted but their bytes are not, and `incomplete_uploads_visible` is `false`.      |
| `s3:GetObject`                  | `_meta/dek.enc` and manifests, needed only for `logical_bytes_referenced`.                                                                |

The report never writes objects, creates a bucket, or generates key material. A monitoring principal with the read-only actions in [Security](/security#s3-permissions-by-command-class), plus the version and multipart list actions, can run it. Measuring a replica whose bucket does not exist fails with `NoSuchBucket`. It does not create the bucket.

## See also

- [Storage layout](/operations/storage-layout): which prefixes each workload uses
- [Immutability](/operations/immutability): retention, which keeps noncurrent versions longer
- [Replication](/operations/replication): measuring a replica
