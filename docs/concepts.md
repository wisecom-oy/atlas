# Concepts

A mental model for how Atlas works, before the CLI flags and configuration options. These terms show up in error messages, CLI output, and the rest of the documentation.

## Packages: CLI vs SDK

Two npm packages share the same engine and target different integration styles:

|               | `@wisecom/atlas-cli`                          | `@wisecom/atlas-sdk`                                      |
| ------------- | --------------------------------------------- | --------------------------------------------------------- |
| **Install**   | `npm install -g @wisecom/atlas-cli`           | `npm add @wisecom/atlas-sdk`                              |
| **Interface** | Shell commands (`atlas outlook backup`, etc.) | Typed TypeScript methods (`atlas.outlook.backup()`, etc.) |
| **Config**    | `.env` file and environment variables         | Explicit object passed to `createAtlasInstance()`         |
| **Best for**  | Cron jobs, systemd timers, operator workflows | Custom apps, multi-tenant SaaS, portals, automation       |

Both cover all three workloads. The CLI is optimized for simple deployment, the SDK for building on top of Atlas programmatically.

## Workloads

Each workload has its own CLI namespace and storage prefix inside the tenant bucket:

| Workload       | CLI namespace      | Target                              | Storage prefix |
| -------------- | ------------------ | ----------------------------------- | -------------- |
| **Outlook**    | `atlas outlook`    | Mailbox (email address or Graph ID) | `outlook/`     |
| **OneDrive**   | `atlas onedrive`   | User (email/UPN or Entra object ID) | `onedrive/`    |
| **SharePoint** | `atlas sharepoint` | Site (URL or Graph site ID)         | `sharepoint/`  |

All workloads share the same per-tenant encryption key (DEK) and S3 bucket. Cross-cutting commands such as `atlas replicate`, `atlas rehydrate`, and `atlas stats` operate across workloads within a tenant.

## Snapshots and Manifests

A **snapshot** is a point-in-time record of a backed-up state. It is not a full copy of the data. It is a **manifest file** listing every backed-up item at that moment along with its metadata: IDs, paths or folder names, SHA-256 checksums, and references to the data objects in S3.

The content itself (ciphertext blobs) lives separately in S3, organized by content address. Several snapshots can reference the same data objects, so a message backed up last week and still present today is pointed to by both snapshots while the object is stored once.

A snapshot is **immutable once written**. Atlas never modifies a snapshot after creation, and with Object Lock enabled on the bucket, the manifest file is locked against deletion for the retention period.

Snapshot IDs differ by workload:

- **Outlook**: short hash IDs (e.g. `snap-a3b2c1`)
- **OneDrive**: `od-snap-<milliseconds>-<6-hex>` (e.g. `od-snap-1735689600000-a1b2c3`)
- **SharePoint**: `sp-snap-<milliseconds>-<6-hex>` (e.g. `sp-snap-1735689600000-a1b2c3`)

`atlas outlook list -s <snapshot-id>` reads the manifest. `atlas outlook restore -s <snapshot-id>` reads the manifest to find which objects to download, decrypts them, and pushes them back to Microsoft Graph. OneDrive and SharePoint follow the same pattern through their `list-snapshots`, `restore`, and `verify` commands.

## Content Addressing and Deduplication

Before writing a message, attachment, or file to S3, Atlas computes the SHA-256 hash of the plaintext content and uses that hash as the storage key. If an object with that key already exists in the bucket, the write is skipped and the existing object is shared.

- **Same message in multiple mailboxes**: a forwarded email or shared attachment is stored once, no matter how many mailboxes received it.
- **Same message in multiple snapshots**: an unchanged message appears in both manifests but occupies storage space once.
- **Same file across OneDrive versions**: re-uploading a file with identical content writes no new blob.
- **Scope is per-tenant**: objects are deduplicated within a single tenant's bucket. Separate tenants have their own buckets and keys and share nothing.

This is also why deleting a snapshot removes only its manifest: other snapshots may still reference the same objects. Mailbox-wide or owner-wide delete does remove the data objects, because at that point no other snapshot can reference them.

## Encryption Envelope

Atlas encrypts with two keys, one wrapping the other. [Security](/security) covers the full model.

- **DEK** (Data Encryption Key): a 256-bit symmetric key generated once per tenant and stored as a versioned, self-describing blob at `_meta/dek.enc`. The blob header records the KDF parameters, and the DEK itself is AES-256-GCM encrypted with a KEK. All message, attachment, and file ciphertext in the bucket is encrypted with the DEK.
- **KEK** (Key Encryption Key): derived from the master passphrase using scrypt (N=65536, r=8, p=1) with a per-wrap random salt and tenant-domain separation. The KEK wraps the DEK and is never stored anywhere, only recomputed on demand from the passphrase and blob metadata.

Because the KEK exists only in memory, an attacker holding the bucket holds ciphertext and KDF parameters, not keys.

## Delta Sync

A **delta link** is a Microsoft Graph API cursor marking the point in a mailbox's, drive's, or library's change history where the last backup ended. The next backup uses it to request only changes since that point, which is what makes incremental syncs fast.

Delta links are stored in the snapshot manifest, per-folder for Outlook, per-drive for OneDrive, and per-library for SharePoint. See [Delta Sync](/operations/delta-sync) for the full mechanism, including full-scan fallback.

## Other Terms

| Term               | Definition                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manifest**       | A JSON file in S3 describing a snapshot: backed-up items, their storage keys, checksums, paths or folder assignments, and delta links. One manifest per snapshot.                                       |
| **Snapshot**       | A point-in-time backup record: a manifest file plus the data objects it references.                                                                                                                     |
| **Tenant**         | A Microsoft 365 organization, identified by its Azure AD tenant ID (a UUID). Each tenant gets its own S3 bucket prefix, its own DEK, and its own backups across all workloads.                          |
| **Owner**          | The Entra object ID of a OneDrive user. CLI commands accept email/UPN and resolve to the object ID automatically.                                                                                       |
| **Site**           | A SharePoint site, identified by URL or Graph site ID (`hostname,site-guid,web-guid`). A site backup covers all document libraries in that site.                                                        |
| **Replica marker** | A file (`_meta/replica.marker`) written to secondary storage targets on first replication. Atlas checks for it to detect a backup command accidentally pointed at a replica instead of primary storage. |

## See Also

- [OneDrive Backup](/onedrive-backup): OneDrive backup, restore, and verification
- [SharePoint Backup](/sharepoint-backup): SharePoint site backup and document library sync
- [Storage Layout](/operations/storage-layout): S3 key structure per workload
- [Delta Sync](/operations/delta-sync): how incremental sync works for Outlook
