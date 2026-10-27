# Immutability and Object Lock

Atlas can store backups with S3 Object Lock, so the storage backend refuses to delete or overwrite them until a retention period ends. The protection holds even if an attacker has valid S3 credentials. It works on AWS S3 and MinIO.

```bash
# 1. Check that the bucket can enforce the policy
atlas storage-check --lock-mode governance --retention-days 30

# 2. Back up with retention
atlas outlook backup -m user@company.com --retention-days 30 --lock-mode governance
```

| Option                 | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `--retention-days <n>` | Retain each object for `n` days. Must be a positive integer.                |
| `--lock-mode <mode>`   | `governance` (default) or `compliance`. Requires `--retention-days`.        |

Atlas rejects `--lock-mode` without `--retention-days`, since a mode alone applies no retention. Without this check, a backup would look immutable and not be.

## Why it matters

Credentials alone cannot protect backups from two threats:

- **Ransomware.** Attackers often delete backups before they encrypt production data. Object Lock blocks that deletion, even with valid credentials.
- **Insiders.** An administrator with full S3 access cannot quietly rewrite history during the retention period.

Without Object Lock, backup security depends entirely on S3 credentials. With it, the storage backend enforces retention for everyone.

## How enforcement works

- **The storage backend enforces the lock.** It rejects overwrites and deletes. Atlas cannot bypass the lock, and no S3 client can either.
- **Manifests record the policy.** Each manifest stores `object_lock.requested` (what you asked for) and `object_lock.effective` (what was applied). Use these fields for audit.
- **Manifest metadata does not protect anything.** The protection comes from the backend.

### Governance and compliance modes

| Property         | `governance` (default)                                 | `compliance`                                              |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Protection       | Blocks normal deletes and overwrites                   | Blocks all deletes and overwrites                         |
| Override         | Principals with `s3:BypassGovernanceRetention`         | Nobody, including the root account                        |
| Typical use      | Everyday protection with an emergency override         | Regulated data that must be kept                          |
| Main risk        | A compromised admin with the bypass permission         | A mistaken long retention cannot be shortened             |

::: danger Compliance mode cannot be undone
An object written in compliance mode cannot be deleted by anyone until its retention expires. There is no override and no support path. Start with `governance`, and use `compliance` only after you have tested retention periods and understand the cost of a mistake.
:::

## Bucket requirements

Atlas checks three things before it writes any data:

1. The bucket exists and is reachable.
2. Versioning is enabled. Object Lock depends on it.
3. Object Lock was enabled when the bucket was created. Most S3 implementations cannot turn it on later.

If a check fails, the backup stops with one of these errors:

| Error                                     | Fix                                                          |
| ----------------------------------------- | ------------------------------------------------------------ |
| `versioning disabled`                     | Enable versioning on the bucket.                             |
| `Object Lock unsupported/disabled`        | Recreate the bucket with Object Lock enabled.                |
| `backend rejected requested mode/headers` | The backend does not support the requested mode.             |

Atlas stops rather than falling back to mutable writes. Otherwise you would learn about the gap only when you needed the guarantee.

Run `atlas storage-check` before your first immutable backup. It reports the bucket class:

| Class                  | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `lock-capable`         | Versioning and Object Lock enabled. Usable for lock. |
| `versioned-only (legacy)` | Versioned without Object Lock. Cannot enforce retention. |
| `unversioned (legacy)` | Neither. Cannot enforce retention.                   |

## Retention and deduplication

Objects are stored under their content hash. If an object already exists, Atlas skips the upload, with or without Object Lock. Only new content costs storage.

Object Lock stops deletion during the retention window. It does not delete anything afterwards. Atlas deletes data only in bulk, through `atlas outlook delete`, the OneDrive and SharePoint delete commands, or `atlas delete --purge`. It never removes a single data object that a manifest still references.

## Deletion under Object Lock

`atlas outlook delete`, the OneDrive and SharePoint delete commands, and `atlas delete --purge` remove objects in a fixed order:

1. **Manifests first.** This removes the index that points to data.
2. **Data objects second.** These are the encrypted messages and files.

If deletion stops between the two steps, you are left with orphan data objects. They are harmless and can be removed later. The reverse order would leave manifests pointing at missing data, which is far worse.

While retention is active, a delete removes what it can and reports what it kept. The command exits with code `8` (`ATLAS_OBJECT_LOCK_RETAINED`) to signal that deletion is incomplete. Treat a purge in an immutable bucket as "delete everything possible and list the leftovers", not as immediate destruction.

## Lifecycle rules

When Atlas creates a bucket, it applies these lifecycle rules, which work on both AWS S3 and MinIO:

| Rule                                      | Purpose                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `AbortIncompleteMultipartUpload` (7 days) | Removes abandoned upload parts.                                     |
| `ExpiredObjectDeleteMarker`               | Removes delete markers left after versioned deletes.                |
| `atlas-expire-noncurrent-versions` (30 days) | Removes noncurrent object versions 30 days after they are replaced. |

Atlas applies these rules on a best-effort basis. If the backend does not support lifecycle configuration, Atlas continues without them.

## Operational notes

- `--lock-mode compliance` is stronger, but it is hard to reverse. Start with `governance`.
- On OneDrive and SharePoint backups, `--retention-days` is described as a default that "persists on the bucket". Treat it as a bucket-level setting, not a per-run one.
- Check retained object counts after each delete attempt to understand your retention exposure.
- Run `atlas storage-check` before each immutable backup campaign.

## See also

- [Storage layout](/operations/storage-layout): which objects the lock protects
- [Replication](/operations/replication): Object Lock on replica buckets is configured separately
- [Storage setup](/self-hosting/storage): creating buckets with Object Lock enabled
