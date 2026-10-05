# Storage Usage

```bash
atlas stats storage                         # the tenant bucket, per workload
atlas stats storage --by owner --top 10     # the ten owners and sites holding the most bytes
atlas stats storage --target-config replica.json   # the replica's copy of the bucket
```

`atlas stats storage` lists the tenant bucket and reports the bytes it physically holds: every version Object Lock or versioning keeps, delete markers, staging objects, and the parts of multipart uploads that never completed. The SDK exposes the same report as [`getStorageUsage()`](/reference/sdk#storage-usage). It works against any S3-compatible backend, because it reads the bucket listing rather than provider metrics, which many backends (MinIO and most on-premise stores among them) do not offer and none split by workload or owner.

## Logical and physical sizes

Atlas reports two different kinds of size, and they answer different questions.

| Size     | Where                                                                                       | Measures                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Logical  | `atlas stats`, `total_size_bytes` on mailbox, drive and site statistics, snapshot summaries | The backed-up items as Microsoft 365 reported them, summed across every snapshot manifest                                    |
| Physical | `atlas stats storage`, `getStorageUsage()`                                                  | What the bucket holds: encrypted, deduplicated objects, retained versions and incomplete upload parts. What a provider bills |

The two differ in both directions. Content-addressed deduplication shrinks the physical size: a message or file stored once is referenced by every snapshot that contains it, and every one of those references counts toward the logical size. Other things grow it: MIME base64 encoding adds about 33% to attachments, each object carries encryption framing, noncurrent versions stay until retention allows their expiry, and legacy per-file index objects and staging leftovers add objects the manifests never mention.

A complete report includes `logical_bytes_referenced`, the logical total `atlas stats` would report, so the ratio of the two is visible in one place. It needs the tenant's data key to read the manifests. A bucket that holds no backups, or a replica without its key, gets a physical report without the logical figure.

## What each category counts

| Category             | Counts                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`            | The latest version of each live object                                                                                                                                                 |
| `noncurrent`         | Older versions, kept by versioning or Object Lock. Atlas sets a 30-day noncurrent expiry on the buckets it creates, and retention can hold a version longer                            |
| `delete_markers`     | Delete markers. They hold no bytes, and Atlas's bucket lifecycle removes markers with nothing left behind them                                                                         |
| `staging`            | Objects under `onedrive/staging/` and `sharepoint/staging/`. Already included in `current` or `noncurrent`; shown separately because a large figure means abandoned large-file uploads |
| `incomplete_uploads` | Multipart uploads never completed or aborted, with the bytes their parts hold. Not in `current`, but billed by most providers                                                          |

`stored_bytes` is `current` plus `noncurrent` plus `incomplete_uploads`. The workload breakdown follows the [storage layout](/operations/storage-layout): `outlook` for `data/`, `attachments/` and `manifests/`, `onedrive/` and `sharepoint/` for their prefixes, `meta` for `_meta/`, and `other` for any key outside the layout. Its rows sum to the totals. With `--by owner` each row is one mailbox, OneDrive owner or SharePoint site, identified by the opaque id the key carries.

## Request cost

The report is exact because it lists everything, and listing costs requests: one `ListObjectVersions` request per 1,000 versions, plus one `ListMultipartUploads` request per 1,000 incomplete uploads and a `ListParts` request for each of those uploads. A tenant with two million stored versions costs about 2,000 list requests per run. On providers that bill list requests (AWS charges them at the PUT, COPY, POST, LIST rate), check that figure against how often you schedule the report. `list_requests` in the output is the exact count for the run.

Atlas lists up to four top-level prefixes in parallel. Memory stays constant regardless of object count: pages are counted and discarded, never collected. With `--by owner` memory grows with the number of owners and sites, not with objects.

## Splitting a long run

```bash
atlas stats storage --max-requests 1000 --json > part1.json
atlas stats storage --max-requests 1000 --continue "$(jq -r .continuation_token part1.json)"
```

`--max-requests` stops the run once that many requests were made and prints a continuation token. Passing the token back resumes where the counts end, so a resumed run never counts an object twice and ends with exactly the totals a single run would report. A page of incomplete uploads lists the parts of each upload on it, so that page can take the run past the allowance. The SDK accepts `maxListRequests` and an `AbortSignal` for the same purpose.

A token is bound to the tenant, the target and the breakdown it was issued for, and is refused anywhere else. It is base64url-encoded JSON, not encrypted: it holds the tenant ID, the counts so far, and the listing position, which is an object key containing a mailbox, owner or site ID. Treat it like the report itself and keep it out of shared logs and tickets.

## Permissions

| Action                          | Needed for                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `s3:ListBucket`                 | Live objects                                                                                                               |
| `s3:ListBucketVersions`         | Noncurrent versions and delete markers. Without it, the report counts live objects only and says `versions_visible: false` |
| `s3:ListBucketMultipartUploads` | Incomplete uploads. Without it, the report says `incomplete_uploads_visible: false` rather than reporting none             |
| `s3:ListMultipartUploadParts`   | Sizing each incomplete upload                                                                                              |
| `s3:GetObject`                  | `_meta/dek.enc` and the manifests, for the logical figure only                                                             |

The report never writes, never creates a bucket, and never generates key material, so a monitoring principal with the read-only permissions in [Security](/security#s3-permissions-by-command-class) plus the version and multipart list actions can run it. Measuring a replica whose bucket does not exist fails with `NoSuchBucket` instead of creating it.
