# Immutability & Object Lock

Atlas supports storage-enforced immutability on AWS S3 and MinIO. When enabled, backup data becomes tamper-proof at the storage layer -- even an attacker with full S3 credentials cannot modify or delete protected objects during the retention window.

## Why Immutability Matters

From a cybersecurity standpoint, immutable backups address two critical threats:

- **Ransomware** — if an attacker compromises your infrastructure, they typically attempt to destroy backups before encrypting production data. With Object Lock, backup objects cannot be deleted or overwritten, even with valid S3 credentials.
- **Insider threats** — a disgruntled administrator with full S3 access cannot silently delete or tamper with historical backups during the retention period.

Without immutability, your backups are only as secure as your S3 credentials. With it, the storage backend itself enforces the retention policy regardless of who holds the keys.

## Enforcement Model

- **Enforced by storage backend** — Object Lock retention prevents overwrite and delete operations based on backend rules, not application logic. Atlas cannot bypass this, and neither can any other S3 client.
- **Recorded by Atlas** — manifests include `object_lock.requested` and `object_lock.effective` timestamps for audit and operational tracking.
- **Not application enforcement** — manifest policy metadata is bookkeeping. The actual protection comes from the storage backend.

## GOVERNANCE vs. COMPLIANCE Mode

Atlas supports both S3 Object Lock modes. The difference is significant for operations:

| Property | GOVERNANCE | COMPLIANCE |
| --- | --- | --- |
| Protection level | Protected against normal delete/overwrite | Protected against ALL delete/overwrite |
| Override | Users with `s3:BypassGovernanceRetention` can override | **Nobody** can override, not even the root account |
| Use case | Day-to-day protection with emergency escape hatch | Regulatory compliance where data must be preserved |
| Risk | A compromised admin account can bypass it | Accidentally set a 10-year retention? You wait 10 years. |

::: danger COMPLIANCE Mode Is Irreversible
Once an object is written with COMPLIANCE mode retention, it **cannot be deleted by anyone** until the retention period expires. There is no override, no support ticket, no workaround. Choose retention periods carefully. Start with GOVERNANCE mode until you understand the operational implications.
:::

## Requirements

Before enabling immutable backups, the S3 bucket must be properly configured:

- Bucket must exist and be reachable
- Bucket **versioning must be enabled** (Object Lock requires versioning)
- Bucket **Object Lock must be enabled** at creation time (cannot be added retroactively on most S3 implementations)

Atlas validates all three conditions before writing any data. If any check fails, the backup **aborts immediately** with a specific error category:

- `versioning disabled` — enable versioning on the bucket
- `Object Lock unsupported/disabled` — recreate the bucket with Object Lock enabled
- `backend rejected requested mode/headers` — the storage backend does not support the requested lock mode

This fail-fast behavior is deliberate. Atlas will never silently downgrade from immutable to mutable writes -- you would not discover the gap until you needed the immutability guarantee.

Use `atlas storage-check` to validate readiness before running your first immutable backup.

## Deduplication & Retention Semantics

Atlas uses content-addressed storage (`data/{mailbox}/{sha256}`). Deduplication works identically with or without Object Lock -- if the object already exists, Atlas skips the upload. No extra storage cost, no extra S3 versions.

Object Lock **prevents deletion** during the retention window but does **not auto-delete** objects after retention expires. Since Atlas never selectively deletes individual data objects (only bulk via `delete --mailbox` or `delete --purge`), there is no risk of a manifest referencing a deleted object.

## Deletion Behavior Under Object Lock

When you run `atlas outlook delete` against immutable data, the deletion order is important:

1. **Manifests are deleted first** — this removes the index that references data objects.
2. **Data objects are deleted second** — these are the actual encrypted messages and attachments.

This ordering is safe: if deletion is interrupted after manifests are removed but before data is cleaned up, you are left with **orphan data blobs** (harmless, can be cleaned later) rather than **dangling manifest references** (dangerous, would point to missing data).

When Object Lock retention is active, delete commands will partially succeed -- objects past their retention window are deleted, and retained objects are reported separately. The exit code is non-zero to signal incomplete deletion.

## Lifecycle Rules

When Atlas creates a new bucket, it attempts to configure lifecycle rules compatible with both AWS S3 and MinIO:

| Rule | Purpose |
| --- | --- |
| `AbortIncompleteMultipartUpload` (7 days) | Cleans up abandoned upload parts that waste storage |
| `ExpiredObjectDeleteMarker` | Removes orphaned delete markers left after version-aware deletion |

These rules are best-effort -- if the storage backend does not support lifecycle configuration, Atlas continues without them.

## Operational Notes

- `--retention-days` is required to enable retention-enforced immutability.
- `--lock-mode compliance` is stronger but operationally harder to reverse -- consider starting with `governance`.
- Purge in immutable environments means "attempt full deletion and report leftovers", not guaranteed immediate destruction.
- Use `atlas storage-check` to validate immutable backup readiness before running a backup.
- Monitor retained object counts after deletion attempts to understand your retention exposure.
