---
description: Measure how many bytes an Atlas tenant bucket holds with atlas stats storage, including object versions, delete markers, and incomplete uploads.
---

# Storage usage

`atlas stats storage` reports how many bytes the tenant bucket physically holds, which is what your provider bills. It counts every version kept by versioning or Object Lock, delete markers, staging objects, and incomplete multipart uploads. It works on any S3-compatible backend, because it reads the bucket listing rather than provider metrics.

```bash
atlas stats storage                                    # totals and per-workload breakdown
atlas stats storage --by owner --top 10                # the ten owners and sites holding the most bytes
ATLAS_S3_ENDPOINT=https://replica.example.com atlas stats storage   # a replica
```

The SDK returns the same report from [`getStorageUsage()`](/reference/sdk#storage-usage).

| Option | Description |
| --- | --- |
| `--by <breakdown>` | `workload` (default) or `owner` |
| `--top <n>` | Rows to show for `--by owner`. Default `20` |
| `--json` | Print the report as JSON. Includes `complete`, `continuation_token`, `versions_visible`, and `measured_at` |
| `--max-requests <n>` | Stop after `n` S3 requests and print a continuation token |
| `--continue <token>` | Resume a run from its continuation token |

## Logical and physical sizes

Atlas reports two sizes that answer different questions:

| Size | Where | Measures |
| --- | --- | --- |
| Logical | `atlas stats`, `total_size_bytes` in mailbox, drive, and site statistics, and snapshot summaries | The items as Microsoft 365 reports them, summed across every snapshot |
| Physical | `atlas stats storage`, `getStorageUsage()` | What the bucket holds, including retained versions and incomplete uploads. This is what a provider bills |

Physical size is usually below logical size, because each unique file or message is stored once and serves every snapshot that references it. Some things push it up:

- base64 encoding in MIME adds about 33% to attachments
- each object carries encryption overhead
- noncurrent versions stay until they expire
- legacy index objects and staging leftovers take space that no snapshot references

A complete report includes `logical_bytes_referenced`, so you can compare the two figures in one place, and `logical_bytes_by_workload` splits it across Outlook, OneDrive, SharePoint, and Teams. Computing it reads the manifests, which needs the tenant's data key. A bucket with no backups, or a copy without the key, returns the physical report only.

## Categories

| Category | Counts |
| --- | --- |
| `current` | The latest version of each live object |
| `noncurrent` | Older versions kept by versioning or Object Lock. Buckets created by Atlas expire them after 30 days. Retention can keep them longer |
| `delete_markers` | Delete markers. They hold no bytes. Atlas's lifecycle rules remove them once nothing remains behind them |
| `staging` | Objects under `onedrive/staging/`, `sharepoint/staging/`, and `teams/staging/`. Already included in `current` or `noncurrent`. A large value usually means abandoned large-file uploads |
| `incomplete_uploads` | Multipart uploads that were never completed or aborted, and the bytes their parts hold. Not in `current`, but most providers bill for them |

`stored_bytes` is `current` + `noncurrent` + `incomplete_uploads`.

The workload breakdown follows the [storage layout](/operations/storage-layout): `outlook` (`data/`, `attachments/`, `manifests/`), `onedrive`, `sharepoint`, `teams`, `meta` (`_meta/`), and `other` (any path outside the layout). The rows add up to the totals. With `--by owner`, each row is one mailbox, OneDrive owner, SharePoint site, or Teams team, identified by the opaque ID in its path.

## Request cost

The report lists every object, so it is exact. Listing costs requests:

- One `ListObjectVersions` request per 1,000 versions.
- One `ListMultipartUploads` request per 100 incomplete uploads.
- One or more `ListParts` requests per incomplete upload, at 1,000 parts per request.

A tenant with two million stored versions needs about 2,000 list requests per run. Providers such as AWS bill list requests at the PUT rate, so weigh that count against how often you schedule the report. The `list_requests` field in the output gives the exact count for each run.

Memory use stays flat as the object count grows. `--by owner` grows with the number of owners and sites, not with the number of objects.

## Split a long run

For large buckets, cap the requests per run and resume:

```bash
atlas stats storage --max-requests 1000 --json > part1.json
atlas stats storage --max-requests 1000 --continue "$(jq -r .continuation_token part1.json)"
```

`--max-requests` counts every request, including the one that sizes an incomplete upload, so a run never exceeds the limit. Resuming continues from the last counted position, and each object is counted once. If the bucket changes between runs, objects written or deleted after the resume position can make the final totals differ from a single uninterrupted run.

If a request fails after the SDK's own retries, such as a `503 SlowDown` or a dropped connection, the run stops and keeps its progress. The CLI prints the continuation token to stderr. In the SDK, `getStorageUsageToken(err)` returns it. Resuming repeats only the failed page.

::: warning Continuation tokens are sensitive
A token is valid only for the tenant, target, and breakdown it was issued for. It is base64url-encoded JSON, not encrypted. It contains the tenant ID, the counts so far, and a listing position that embeds a mailbox, owner, or site ID. Treat it like the report itself, and keep it out of shared logs and tickets.
:::

## Permissions

| S3 action | Used for |
| --- | --- |
| `s3:ListBucket` | Live objects |
| `s3:ListBucketVersions` | Noncurrent versions and delete markers. Without it, the report counts live objects only and sets `versions_visible: false` |
| `s3:ListBucketMultipartUploads` | Incomplete uploads. Without it, the report sets `incomplete_uploads_visible: false` rather than reporting zero |
| `s3:ListMultipartUploadParts` | Sizing each incomplete upload. Without it, uploads are counted but their bytes are not, and `incomplete_uploads_visible` is `false` |
| `s3:GetObject` | `_meta/dek.enc` and manifests, needed only for `logical_bytes_referenced` |

The report never writes objects, creates a bucket, or generates key material. A monitoring principal with the read-only actions in [Security](/security#s3-permissions-by-command-class), plus the version and multipart list actions, can run it. Against an endpoint where the bucket does not exist, the report fails rather than create it.

## See also

- [Storage layout](/operations/storage-layout): which prefixes each workload uses
- [Immutability](/operations/immutability): retention, which keeps noncurrent versions longer
- [Replicas](/operations/replication): pointing Atlas at a replica
