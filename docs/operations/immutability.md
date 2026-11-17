---
description: Store Atlas backups with S3 Object Lock so AWS S3 or MinIO refuses to delete or overwrite them until retention ends.
---

# Immutability and Object Lock

With S3 Object Lock, the storage backend refuses to delete or overwrite a backup until its retention period ends. Atlas supports it on AWS S3 and MinIO. In `compliance` mode the protection holds even against an attacker with valid S3 credentials. In `governance` mode, the default, a principal with `s3:BypassGovernanceRetention` can still remove objects.

```bash
# 1. Check that the bucket can enforce the policy
atlas storage-check --lock-mode governance --retention-days 30

# 2. Back up with retention
atlas outlook backup -m user@example.com --retention-days 30 --lock-mode governance
```

| Option | Description |
| --- | --- |
| `--retention-days <n>` | Retain each object this run writes for `n` days. Must be a positive integer |
| `--lock-mode <mode>` | `governance` (default) or `compliance`. Requires `--retention-days` |

Atlas rejects `--lock-mode` without `--retention-days`, because a mode alone applies no retention and the backup would look immutable without being so.

## What Object Lock protects against

Without Object Lock, backup security rests entirely on the S3 credentials. With it, the storage backend enforces retention for everyone, except a principal with the bypass permission on a `governance` object.

- **Ransomware.** Attackers often delete backups before they encrypt production data. Object Lock blocks that deletion even with valid credentials, unless the object is in `governance` mode and the principal holds `s3:BypassGovernanceRetention`.
- **Insiders.** In `compliance` mode, no administrator can rewrite history during the retention period. In `governance` mode, an administrator with the bypass permission can.

For what each credential can do to locked and unlocked data, see the [Security model](/security#retention-is-stamped-per-object).

## Governance and compliance modes

| Property | `governance` (default) | `compliance` |
| --- | --- | --- |
| Protection | Blocks normal deletes and overwrites | Blocks all deletes and overwrites |
| Override | Principals with `s3:BypassGovernanceRetention` | Nobody, including the root account |
| Typical use | Everyday protection with an emergency override | Regulated data that must be kept |
| Main risk | A compromised admin with the bypass permission | A mistaken long retention cannot be shortened |

::: danger Compliance mode cannot be undone
An object written in compliance mode cannot be deleted by anyone until its retention expires. There is no override and no support path. Start with `governance`, and move to `compliance` only after you have tested your retention periods and understand the cost of a mistake.
:::

## Bucket requirements

Object Lock must be enabled when the bucket is created. Most S3 implementations cannot turn it on later. Buckets Atlas creates itself are created with Object Lock enabled, which also turns on versioning. If the backend rejects that, Atlas creates a plain bucket and warns that `--retention-days` will not work on it.

Run `atlas storage-check` before your first immutable backup. It reports the bucket class:

| Class | Meaning |
| --- | --- |
| `lock-capable` | Versioning and Object Lock enabled. Usable for retention |
| `versioned-only (legacy)` | Versioned without Object Lock. Cannot enforce retention |
| `unversioned (legacy)` | Neither. Cannot enforce retention |

Before a backup with `--retention-days` writes any data, Atlas checks that the bucket exists and is reachable, that versioning is enabled, and that Object Lock is enabled. If a check fails, the backup stops:

| Error | Message | Fix |
| --- | --- | --- |
| `ObjectLockVersioningDisabledError` | `Immutability requested, but bucket versioning is disabled for <bucket>.` | Enable versioning on the bucket |
| `ObjectLockUnsupportedError` | `Immutability requested, but Object Lock is not supported or not enabled for bucket <bucket>.` | Recreate the bucket with Object Lock enabled |
| `ObjectLockModeRejectedError` | `Backend rejected Object Lock mode <mode> for bucket <bucket>.` | The backend does not support the requested mode or headers |

Atlas stops instead of falling back to writes without a lock, so you never learn about the gap only when you need the guarantee.

## How retention is applied

- **The storage backend enforces the lock.** It rejects overwrites and deletes. Atlas never requests a governance bypass, and no S3 client can get past a `compliance` lock.
- **Retention is set per object.** `--retention-days` locks only the objects that run writes. Atlas never sets or changes a bucket default retention. If `atlas storage-check` reports one, it was left by Atlas before 6.1.0 or set by hand. See [Removing a bucket default retention](/self-hosting/storage#removing-a-bucket-default-retention).
- **Manifests record the policy for audit.** Each manifest stores `object_lock.requested` (what you asked for) and `object_lock.effective` (what was applied). This metadata records the policy. It does not protect anything; the backend does.
- **Reused content keeps its first retention.** Each unique file or message is stored once. If an object already exists, Atlas skips the upload, with or without Object Lock, so only new content costs storage. A reused object keeps the retention it received on its first write, and a later run does not extend it.

## Deleting data under Object Lock

Object Lock stops deletion during the retention window. It does not delete anything afterwards. Atlas deletes data only in bulk, through `atlas outlook delete`, `atlas teams delete`, the OneDrive and SharePoint delete commands, or `atlas delete --purge`. It never removes a single data object that a manifest still references.

These commands remove objects in a fixed order:

1. **Manifests first.** This removes the index that points to data.
2. **Data objects second.** These are the encrypted messages and files.

If deletion stops between the two steps, the leftover data objects are orphans. They are harmless and can be removed later. The reverse order would leave manifests pointing at missing data. `atlas teams delete` removes the channel cursors first, then the snapshot indexes, then the channel shards, then the message and image blobs.

While retention is active, a delete removes what it can and reports what it kept:

```
Retained and not deleted: <n> object(s), <n> manifest(s)
```

The command then exits with code `1` to signal that deletion is incomplete. Treat a purge in an immutable bucket as "delete everything possible and list the leftovers", not as immediate destruction. For how retained and failed deletes are told apart, see [Erasure](/security#erasure).

::: danger Retention also blocks erasure
Data under retention stays in the bucket, and readable with the tenant key, until its retain-until date passes, even after an erasure request. Plan erasure timelines around the longest retention period in use.
:::

## Lifecycle rules

When Atlas creates a bucket, it applies two lifecycle rules, which work on both AWS S3 and MinIO:

| Rule | Purpose |
| --- | --- |
| `atlas-housekeeping` | Aborts incomplete multipart uploads after 7 days (`AbortIncompleteMultipartUpload`) and removes delete markers left after versioned deletes (`ExpiredObjectDeleteMarker`) |
| `atlas-expire-noncurrent-versions` | Removes noncurrent object versions 30 days after they are replaced. A locked version stays until its lock expires |

The rules are best effort. If the backend does not support lifecycle configuration, Atlas continues without them. Buckets that already exist are left as they are.

## Operational checklist

- Start with `governance`. `compliance` is stronger, but it cannot be reversed.
- Run `atlas storage-check` before each immutable backup campaign.
- After each delete attempt, check the retained object counts to understand your retention exposure.

## See also

- [Storage layout](/operations/storage-layout): which objects the lock protects
- [Replicas](/operations/replication): Object Lock on a replica bucket is configured on the replica
- [Storage setup](/self-hosting/storage): creating buckets with Object Lock enabled
- [Security model](/security): encryption, erasure, and what each credential allows
