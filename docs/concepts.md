# Concepts

A mental model for how Atlas works before diving into CLI flags and configuration options. These concepts appear frequently in error messages, CLI output, and the rest of the documentation.

## CLI vs SDK

Atlas is published as two npm packages that share the same engine but target different integration styles:

| | `@wisecom/atlas-cli` | `@wisecom/atlas-sdk` |
| --- | --- | --- |
| **Install** | `npm install -g @wisecom/atlas-cli` | `npm add @wisecom/atlas-sdk` |
| **Interface** | Shell commands (`atlas outlook backup`, etc.) | Typed TypeScript methods (`atlas.outlook.backup()`, etc.) |
| **Config** | `.env` file and environment variables | Explicit object passed to `createAtlasInstance()` |
| **Best for** | Cron jobs, systemd timers, operator workflows | Custom apps, multi-tenant SaaS, portals, automation |

Both packages support Outlook, OneDrive, and SharePoint workloads. The CLI is optimized for simple deployment; the SDK is for building on top of Atlas programmatically.

## Workloads

Atlas protects three Microsoft 365 workloads, each with its own CLI namespace and storage prefix within the tenant bucket:

| Workload | CLI namespace | Target | Storage prefix |
| -------- | ------------- | ------ | -------------- |
| **Outlook** | `atlas outlook` | Mailbox (email address or Graph ID) | `outlook/` |
| **OneDrive** | `atlas onedrive` | User (email/UPN or Entra object ID) | `onedrive/` |
| **SharePoint** | `atlas sharepoint` | Site (URL or Graph site ID) | `sharepoint/` |

All workloads share the same per-tenant encryption key (DEK) and S3 bucket. Cross-cutting commands like `atlas replicate`, `atlas rehydrate`, and `atlas stats` operate across workloads within a tenant.

## What Is a Snapshot?

A **snapshot** is a point-in-time record of a backed-up state. It is not a full copy of all data -- it is a **manifest file** that lists every backed-up item at a given moment, along with metadata: IDs, paths or folder names, SHA-256 checksums, and references to the data objects stored in S3.

The actual content (ciphertext blobs) lives separately in S3, organized by content address. Multiple snapshots can reference the same data objects -- if a message or file was backed up last week and is still present today, both snapshots point to the same S3 object. The object is stored once.

A snapshot is **immutable once written**. Atlas never modifies a snapshot after creation. If Object Lock is enabled on the bucket, the manifest file is locked against deletion for the retention period.

Snapshot IDs differ by workload:

- **Outlook** — short hash IDs (e.g. `snap-a3b2c1`)
- **OneDrive** — `od-snap-<milliseconds>-<6-hex>` (e.g. `od-snap-1735689600000-a1b2c3`)
- **SharePoint** — `sp-snap-<milliseconds>-<6-hex>` (e.g. `sp-snap-1735689600000-a1b2c3`)

When you run `atlas outlook list -s <snapshot-id>`, you are reading the manifest. When you run `atlas outlook restore -s <snapshot-id>`, Atlas reads the manifest to find which objects to download, decrypts them, and pushes them back to Microsoft Graph. OneDrive and SharePoint follow the same pattern with their respective `list-snapshots`, `restore`, and `verify` commands.

## What Does Deduplication Mean?

Atlas uses **SHA-256 content addressing** to deduplicate data. Before writing a message, attachment, or file to S3, Atlas computes the SHA-256 hash of the plaintext content and uses that hash as the storage key. If an object with that key already exists in the bucket, the write is skipped -- the existing object is shared.

In practice, this means:

- **Same message in multiple mailboxes**: a forwarded email or shared attachment is stored once, regardless of how many mailboxes received it.
- **Same message in multiple snapshots**: a message that has not changed between two backups appears in both manifests but occupies storage space only once.
- **Same file across OneDrive versions**: if a file is re-uploaded with identical content, the blob is not written again.
- **Deduplication scope is per-tenant**: objects are deduplicated within a single tenant's bucket. Two separate tenants with their own buckets and encryption keys do not share objects.

This also explains why snapshot-level delete only removes the manifest, not the data objects: other snapshots may still reference the same objects. Mailbox-wide or owner-wide delete removes all data objects for that target because it is certain no other snapshots reference them.

## Key Terms Glossary

| Term | Definition |
| ---- | ---------- |
| **DEK** (Data Encryption Key) | A 256-bit symmetric key generated once per tenant and stored as a versioned, self-describing blob at `_meta/dek.enc`. The blob header records the KDF parameters; the DEK itself is AES-256-GCM encrypted with a KEK. All message, attachment, and file ciphertext in the bucket is encrypted with the DEK. |
| **KEK** (Key Encryption Key) | A key derived from the master passphrase using scrypt (N=65536, r=8, p=1) with a per-wrap random salt and tenant-domain separation. The KEK wraps (encrypts) the DEK -- it is never stored anywhere, only recomputed on demand from the passphrase and blob metadata. |
| **Delta link** | A Microsoft Graph API cursor that marks the point in a mailbox's, drive's, or library's change history where the last backup ended. On the next backup, Atlas uses the delta link to request only changes since that point, making incremental syncs fast. Delta links are stored per-folder (Outlook), per-drive (OneDrive), or per-library (SharePoint) in the snapshot manifest. |
| **Manifest** | A JSON file stored in S3 that describes a snapshot: list of backed-up items, their storage keys, checksums, paths or folder assignments, and delta links. One manifest file per snapshot. |
| **Snapshot** | A point-in-time backup record, consisting of a manifest file and the data objects it references. |
| **Tenant** | A Microsoft 365 organization, identified by its Azure AD tenant ID (a UUID). Each tenant gets its own S3 bucket prefix, its own DEK, and its own set of backups across all workloads. |
| **Owner** | The Entra object ID of a OneDrive user. CLI commands accept email/UPN and resolve to the object ID automatically. |
| **Site** | A SharePoint site, identified by URL or Graph site ID (`hostname,site-guid,web-guid`). Each site backup covers all document libraries within that site. |
| **Replica marker** | A file (`_meta/replica.marker`) written to secondary storage targets on first replication. Atlas checks for this file to detect when a backup command is accidentally run against a replica instead of primary storage. |

## See Also

- [OneDrive Backup](/onedrive-backup) — OneDrive-specific backup, restore, and verification
- [SharePoint Backup](/sharepoint-backup) — SharePoint site backup and document library sync
- [Storage Layout](/operations/storage-layout) — S3 key structure per workload
- [Delta Sync](/operations/delta-sync) — how incremental sync works for Outlook
