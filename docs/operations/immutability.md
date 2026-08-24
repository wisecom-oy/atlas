# Immutability & Object Lock

Atlas supports storage-enforced immutability on AWS S3 and MinIO. When enabled, backup data becomes tamper-proof at the storage layer. Even an attacker holding full S3 credentials cannot modify or delete protected objects during the retention window.

```bash
# 1. Confirm the bucket can enforce the policy you plan to use
atlas storage-check --lock-mode governance --retention-days 30

# 2. Back up with storage-enforced retention
atlas outlook backup -m user@company.com --retention-days 30 --lock-mode governance
```

| Option                 | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `--retention-days <n>` | Apply Object Lock retention for `n` days        |
| `--lock-mode <mode>`   | Object Lock mode (`governance` or `compliance`) |

A run that asks for retention fails when the bucket cannot honour it. Versioning off, Object Lock off, or the requested mode unsupported all abort the write rather than storing unprotected data, so a backup never silently downgrades to mutable objects. Check a bucket before relying on it with `atlas storage-check --lock-mode governance --retention-days 30`.

## Why immutability matters

Immutable backups address two threats that credential hygiene alone cannot:

- **Ransomware.** An attacker who compromises your infrastructure typically destroys backups before encrypting production data. With Object Lock, backup objects cannot be deleted or overwritten even with valid S3 credentials.
- **Insider threats.** A disgruntled administrator with full S3 access cannot silently delete or tamper with historical backups during the retention period.

Without immutability, your backups are only as secure as your S3 credentials. With it, the storage backend enforces the retention policy regardless of who holds the keys.

## How enforcement works

- **Enforced by the storage backend.** Object Lock retention blocks overwrite and delete operations using backend rules, not application logic. Atlas cannot bypass this, and neither can any other S3 client.
- **Recorded by Atlas.** Manifests include `object_lock.requested` and `object_lock.effective` timestamps for audit and operational tracking.
- **Not application enforcement.** Manifest policy metadata is bookkeeping. The actual protection comes from the storage backend.

### GOVERNANCE vs. COMPLIANCE mode

Atlas supports both S3 Object Lock modes, and the difference is significant for operations:

| Property         | GOVERNANCE                                             | COMPLIANCE                                               |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Protection level | Protected against normal delete/overwrite              | Protected against ALL delete/overwrite                   |
| Override         | Users with `s3:BypassGovernanceRetention` can override | **Nobody** can override, not even the root account       |
| Use case         | Day-to-day protection with emergency escape hatch      | Regulatory compliance where data must be preserved       |
| Risk             | A compromised admin account can bypass it              | Accidentally set a 10-year retention? You wait 10 years. |

:::: danger COMPLIANCE mode is irreversible
Once an object is written with COMPLIANCE mode retention, it **cannot be deleted by anyone** until the retention period expires. There is no override, no support ticket, no workaround. Choose retention periods carefully, and start with GOVERNANCE mode until you understand the operational implications.
::::

## Bucket requirements

Before enabling immutable backups, the S3 bucket must satisfy three conditions:

- The bucket exists and is reachable.
- Bucket **versioning is enabled** (Object Lock requires versioning).
- Bucket **Object Lock is enabled** at creation time. Most S3 implementations cannot add it retroactively.

Atlas validates all three before writing any data. If a check fails, the backup **aborts immediately** with a specific error category:

| Error category                            | Fix                                                       |
| ----------------------------------------- | --------------------------------------------------------- |
| `versioning disabled`                     | Enable versioning on the bucket                           |
| `Object Lock unsupported/disabled`        | Recreate the bucket with Object Lock enabled              |
| `backend rejected requested mode/headers` | The storage backend does not support the requested mode   |

The fail-fast behavior is deliberate. Atlas never silently downgrades from immutable to mutable writes, because you would not discover the gap until you needed the immutability guarantee.

Run `atlas storage-check` to validate readiness before your first immutable backup.

## Deduplication and retention semantics

Atlas uses content-addressed storage (`data/{mailbox}/{sha256}`). Deduplication behaves identically with or without Object Lock: if the object already exists, Atlas skips the upload. No extra storage cost, no extra S3 versions.

Object Lock **prevents deletion** during the retention window but does **not auto-delete** objects after retention expires. Since Atlas never selectively deletes individual data objects (only bulk via `delete --mailbox` or `delete --purge`), no manifest can end up referencing a deleted object.

## Deletion behavior under Object Lock

`atlas outlook delete` removes objects in a fixed order:

1. **Manifests first.** This removes the index that references data objects.
2. **Data objects second.** These are the actual encrypted messages and attachments.

The ordering is safe. If deletion is interrupted after manifests are removed but before data is cleaned up, you are left with **orphan data blobs** (harmless, cleanable later) rather than **dangling manifest references** (dangerous, pointing at missing data).

While retention is active, delete commands partially succeed: objects past their retention window are deleted, and retained objects are reported separately. The exit code is non-zero to signal incomplete deletion.

## Lifecycle rules

When Atlas creates a new bucket, it attempts to configure lifecycle rules compatible with both AWS S3 and MinIO:

| Rule                                      | Purpose                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `AbortIncompleteMultipartUpload` (7 days) | Cleans up abandoned upload parts that waste storage               |
| `ExpiredObjectDeleteMarker`               | Removes orphaned delete markers left after version-aware deletion |

These rules are best-effort. If the storage backend does not support lifecycle configuration, Atlas continues without them.

## Operational notes

- `--retention-days` is required to enable retention-enforced immutability.
- `--lock-mode compliance` is stronger but operationally harder to reverse, so consider starting with `governance`.
- Purge in immutable environments means "attempt full deletion and report leftovers", not guaranteed immediate destruction.
- Use `atlas storage-check` to validate immutable backup readiness before running a backup.
- Monitor retained object counts after deletion attempts to understand your retention exposure.
