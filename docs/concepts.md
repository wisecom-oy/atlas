# Concepts

This page explains the terms you will see in CLI output, error messages, and the rest of the documentation: packages, workloads, snapshots, encryption, and delta sync.

## Packages: CLI and SDK

Atlas ships as two npm packages built on the same engine:

|               | `@wisecom/atlas-cli`                          | `@wisecom/atlas-sdk`                                      |
| ------------- | --------------------------------------------- | --------------------------------------------------------- |
| **Install**   | `npm install -g @wisecom/atlas-cli`           | `npm add @wisecom/atlas-sdk`                              |
| **Interface** | Shell commands such as `atlas outlook backup` | Typed methods such as `atlas.outlook.backup()`            |
| **Config**    | `.env` file, environment variables, or `atlas config` | Object passed to `createAtlasInstance()`          |
| **Best for**  | Cron jobs, systemd timers, operator workflows | Custom applications, multi-tenant services, portals       |

Both cover all three workloads. The CLI suits simple deployments. The SDK suits applications that call Atlas programmatically.

## Workloads

Atlas backs up three Microsoft 365 workloads. Each has its own CLI namespace and storage prefix in the tenant's bucket:

| Workload       | CLI namespace      | Target                                       | Storage prefix |
| -------------- | ------------------ | -------------------------------------------- | -------------- |
| **Outlook**    | `atlas outlook`    | Mailbox (email address or Entra object ID)   | `outlook/`     |
| **OneDrive**   | `atlas onedrive`   | User (email or UPN, or Entra object ID)      | `onedrive/`    |
| **SharePoint** | `atlas sharepoint` | Site (URL or Graph site ID)                  | `sharepoint/`  |

All workloads in a tenant share one data encryption key and one S3 bucket. Commands that operate across workloads, such as `atlas replicate`, `atlas rehydrate`, and `atlas stats`, act on the whole tenant.

## Snapshots and manifests

A **snapshot** is a point-in-time record of what Atlas backed up. It is not a full copy of the data. Each snapshot is backed by a **manifest**, a JSON file in S3 that lists every item in that snapshot along with its metadata: IDs, paths or folder names, SHA-256 checksums, and the keys of the encrypted objects that hold the content.

Content objects are stored separately and shared between snapshots. A message that is still present in next week's backup points to the same object as today's backup, so the content is stored once.

Snapshots are written once and never modified. With Object Lock enabled on the bucket, retention locks manifests against deletion for the configured period. See [Storage layout](./operations/storage-layout.md) for the key structure.

A run that finds no changes writes no new snapshot, so the latest snapshot stays current.

Snapshot IDs depend on the workload:

- **Outlook**: `snap-` followed by a short hash, for example `snap-a3b2c1`
- **OneDrive**: `od-snap-<milliseconds>-<6-hex>`, for example `od-snap-1735689600000-a1b2c3`
- **SharePoint**: `sp-snap-<milliseconds>-<6-hex>`, for example `sp-snap-1735689600000-a1b2c3`

Commands that read a snapshot, such as `atlas outlook list -s <snapshot-id>`, `atlas outlook restore -s <snapshot-id>`, and the `list-snapshots`, `restore`, and `verify` commands for OneDrive and SharePoint, use the manifest to find and decrypt the objects they need.

## Content addressing and deduplication

Before writing a message, attachment, or file, Atlas computes the SHA-256 hash of its plaintext content and uses it, prefixed by the owner's ID, as the object's storage key: `data/<owner-id>/<sha256>` for messages, `attachments/<owner-id>/<sha256>` for attachments, and the drive prefixes for OneDrive and SharePoint. If an object with that key already exists, Atlas skips the write and points the new manifest entry at the existing object.

- **Same message in several mailboxes**: each mailbox keeps its own copy, because the key includes the owner ID.
- **Same message in several snapshots**: an unchanged item adds a manifest entry, not a second copy of the data.
- **Same file across OneDrive versions**: re-uploading identical content writes no new object.

Deduplication is scoped to one owner: a mailbox, OneDrive owner, or SharePoint site. Identical content in two owners is stored twice. Tenants do not share objects.

Deleting a snapshot removes only its manifest, because other snapshots may still reference the same objects. Deleting a whole mailbox or owner removes its data objects as well, because no remaining snapshot can reference them. See [Troubleshooting](./troubleshooting.md) for the delete commands.

## Encryption envelope

Atlas uses two keys, where one wraps the other. [Security](./security.md) describes the full model.

- **DEK (data encryption key)**: a 256-bit AES key generated once per tenant. It is stored as a self-describing blob at `_meta/dek.enc`, with the KDF parameters in its header. The DEK is wrapped with the KEK using AES-256-GCM. All content in the bucket is encrypted with the DEK.
- **KEK (key encryption key)**: derived from your master passphrase with scrypt (N=65536, r=8, p=1), a per-wrap random salt, and the tenant ID as a domain separator. The KEK is never stored. Atlas recomputes it from the passphrase whenever it needs it.

Because the KEK exists only in memory, a copy of the bucket contains ciphertext and KDF parameters but no usable keys. The passphrase is the only way back in, so losing it means losing access to the backups.

## Delta sync

A **delta link** is a Microsoft Graph cursor that marks where the previous backup ended in a mailbox's, drive's, or library's change history. The next backup asks Graph only for changes after that point, which keeps incremental runs fast.

Atlas stores delta state per folder for Outlook, per drive for OneDrive, and per library for SharePoint. See [Delta sync](./operations/delta-sync.md) for how Atlas handles full-scan fallback.

## Other terms

| Term               | Definition                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manifest**       | A JSON file in S3 that describes one snapshot: its items, storage keys, checksums, paths or folder assignments, and delta links.                                                  |
| **Snapshot**       | A point-in-time backup record: a manifest plus the objects it references.                                                                                                         |
| **Tenant**         | A Microsoft 365 organization, identified by its Microsoft Entra tenant ID (a GUID). Each tenant has its own DEK and its own backups across all workloads.                         |
| **Owner**          | The Entra object ID of a OneDrive user. CLI commands accept an email address or UPN and resolve it to the object ID.                                                               |
| **Site**           | A SharePoint site, identified by URL or Graph site ID. Storage keys use the site and web GUIDs without the hostname, so renaming the SharePoint domain does not start a new history. |
| **Replica marker** | The file `_meta/replica.marker`, written to secondary storage targets on first replication. Atlas checks for it to detect a backup command accidentally pointed at a replica instead of primary storage. |

## See also

- [OneDrive backup](./onedrive-backup.md): backup, restore, and verification for OneDrive
- [SharePoint backup](./sharepoint-backup.md): site backup and document library sync
- [Storage layout](./operations/storage-layout.md): S3 key structure for each workload
- [Delta sync](./operations/delta-sync.md): how incremental sync works for Outlook
