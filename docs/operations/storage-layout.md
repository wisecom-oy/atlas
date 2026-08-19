# Storage Layout

Each tenant gets its own S3 bucket named `atlas-{tenant_id}`. The bucket holds three workload prefixes (Outlook at the root, OneDrive under `onedrive/`, and SharePoint under `sharepoint/`) plus shared metadata under `_meta/`:

```
atlas-{tenant_id}/
├── _meta/
│   ├── dek.enc                              # wrapped DEK (encrypted with KEK)
│   ├── outlook-manifests/                   # encrypted Outlook lookup pointers
│   │   ├── owners/{mailbox_id}/latest.json  # latest manifest key for incremental backup
│   │   └── snapshots/{snapshot_id}.json     # manifest key for direct snapshot lookup
│   └── replication/                         # replication status sidecars
│       ├── {mailbox_id}/                    # Outlook replication status
│       ├── onedrive/{owner_id}/             # OneDrive replication status
│       └── sharepoint/{site_id}/            # SharePoint replication status
├── data/
│   └── {mailbox_id}/
│       └── {sha256}                         # encrypted message (content-addressed)
├── attachments/
│   └── {mailbox_id}/
│       └── {sha256}                         # encrypted attachment (content-addressed)
├── manifests/
│   └── {mailbox_id}/
│       └── {snapshot_id}.json               # encrypted Outlook manifest
├── onedrive/
│   ├── data/{owner_id}/{sha256}             # encrypted file blobs
│   ├── manifests/{owner_id}/{snapshot_id}.json
│   ├── index/{owner_id}/files/{file_id}.json
│   ├── staging/{owner_id}/{item_id}-{rand}  # temporary multipart staging
│   └── _meta/{owner_id}/delta.json          # encrypted delta cursors
└── sharepoint/
    ├── data/{site_id}/{sha256}              # encrypted file blobs
    ├── manifests/{site_id}/{snapshot_id}.json
    ├── index/{site_id}/files/{file_id}.json
    ├── staging/{site_id}/{item_id}-{rand}   # temporary multipart staging
    └── _meta/{site_id}/delta.json           # encrypted delta cursors
```

## Per-tenant bucket isolation

Every tenant is stored in a completely separate S3 bucket. This is a deliberate security boundary: compromising one bucket's S3 credentials does **not** grant access to any other tenant's data. Each bucket has its own ACLs, its own encryption key (`dek.enc`), and can carry its own Object Lock and lifecycle policies.

For managed service providers backing up multiple tenants, this isolation means you can grant per-tenant access to bucket contents without exposing cross-tenant data.

## Key paths

### Outlook

| Prefix                                         | Contents                                       | Security notes                                                                 |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `_meta/dek.enc`                                | Wrapped data encryption key (one per tenant)   | **Most critical object.** Losing it means losing access to all tenant data     |
| `_meta/outlook-manifests/owners/{mailbox}/`    | Pointer to the latest Outlook manifest         | Encrypted; updated after each successful manifest upload                       |
| `_meta/outlook-manifests/snapshots/{snapshot}` | Pointer from snapshot ID to its manifest key   | Encrypted; avoids a tenant-wide manifest listing                               |
| `data/{mailbox}/`                              | Encrypted email messages, addressed by SHA-256 | Content is encrypted; S3 metadata is not                                       |
| `attachments/{mailbox}/`                       | Encrypted attachments, addressed by SHA-256    | Content is encrypted; S3 metadata is not                                       |
| `manifests/{mailbox}/`                         | Encrypted snapshot manifests (JSON)            | Contains subjects, folder names, and delta URLs, all encrypted                 |

The lookup pointers keep incremental backup reads constant as snapshot history grows: Atlas reads the owner's `latest.json` pointer, then that one manifest. Buckets created by older Atlas versions remain compatible. Their first incremental run after upgrade falls back to the existing manifest scan, and saving the new snapshot creates the pointers used by later runs. The pointers contain only an encrypted manifest object key and are removed with their mailbox or snapshot.

#### Shared mailbox tracking

Each Outlook manifest records an optional `mailbox_purpose` field, the Graph `mailboxSettings.userPurpose` value (`user`, `shared`, `room`, ...) at backup time. Shared mailboxes are typically unlicensed and therefore invisible to license-based inventories, so this flag is what identifies them in the backup catalog.

Converting a user mailbox to a shared mailbox keeps its Entra object ID, so the `manifests/{mailbox}/` prefix stays stable across the conversion. Manifests written before the conversion read `user`, later ones read `shared`, and content blobs under `data/{mailbox}/` (addressed by SHA-256) are shared across both, so message data is stored once. Manifests written before the field existed simply omit it.

### OneDrive

| Prefix                                 | Contents                                   | Security notes                                          |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `onedrive/data/{owner_id}/`            | Encrypted file blobs, addressed by SHA-256 | Content is encrypted; owner uses opaque Entra object ID |
| `onedrive/manifests/{owner_id}/`       | Encrypted snapshot manifests               | Contains file paths, checksums, change types            |
| `onedrive/index/{owner_id}/files/`     | Per-file version indexes                   | Maps file IDs to snapshot versions                      |
| `onedrive/_meta/{owner_id}/delta.json` | Encrypted delta cursors                    | Required for incremental sync                           |

### SharePoint

| Prefix                                  | Contents                                   | Security notes                                |
| --------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| `sharepoint/data/{site_id}/`            | Encrypted file blobs, addressed by SHA-256 | Content is encrypted; site uses Graph site ID |
| `sharepoint/manifests/{site_id}/`       | Encrypted snapshot manifests               | Contains file paths, checksums, change types  |
| `sharepoint/index/{site_id}/files/`     | Per-file version indexes                   | Maps file IDs to snapshot versions            |
| `sharepoint/_meta/{site_id}/delta.json` | Encrypted delta cursors                    | Required for incremental sync                 |

Subsites are stored exactly like any other site. A subsite is a Graph site with its own `site_id`, so `atlas sharepoint backup --include-subsites` writes one snapshot per subsite under that subsite's own `sharepoint/manifests/{site_id}/` prefix rather than folding its files into the parent site's manifest. Blobs, indexes, and delta cursors follow the same per-`site_id` split, which keeps a subsite's backup, restore, and retention independent of its parent.

## The `_meta/dek.enc` object

This is the single most important object in the bucket. It holds the **Data Encryption Key (DEK)** wrapped (encrypted) with the KEK derived from your passphrase. Without this file:

- No message can be decrypted
- No manifest can be read
- No restore is possible

If `_meta/dek.enc` is deleted or corrupted, all data in the bucket becomes permanently inaccessible unless you hold a separate backup of the DEK. Consider extra protection for this prefix:

- S3 bucket policies that restrict delete operations on `_meta/*`
- Object Lock with extended retention on this specific prefix
- Regular verification that the file exists and is accessible

## Content-addressed storage

Messages and attachments use their **SHA-256 hash** as the object key (for example `data/{mailbox}/a1b2c3d4...`). The hash is taken over the **plaintext** content, before encryption.

This gives automatic deduplication: if the same email appears in multiple snapshots, which is common with incremental backups, it is stored once. The manifest references the hash, and every snapshot containing that message points to the same S3 object.

Integrity verification follows from the same property. Decrypt the object, hash the result, and compare against the key. A match proves the content is exactly what was backed up.

## S3 object metadata

Each uploaded object carries S3 metadata headers:

| Header                          | Value                                   | Encrypted                     |
| ------------------------------- | --------------------------------------- | ----------------------------- |
| `x-amz-meta-x-message-id`       | Microsoft Graph message ID              | **No**, visible to S3 access  |
| `x-amz-meta-x-plaintext-sha256` | SHA-256 of original plaintext           | **No**, visible to S3 access  |
| `Content-MD5`                   | MD5 of ciphertext (transport integrity) | N/A, standard S3 header       |

:::: warning Metadata visibility
S3 object metadata is **not encrypted**. Anyone with S3 read access (for example `s3:GetObject` or `s3:ListBucket` with metadata) can see Graph message IDs and plaintext hashes. The message **content** stays encrypted, but the metadata reveals that specific messages exist and what their content hashes are. That is the trade-off: metadata enables deduplication checks and integrity verification without decryption, and it leaks existence information.

Where even metadata exposure is unacceptable, restrict S3 access to the Atlas service account only and use network-level controls (VPC, firewall rules) to limit who can reach the S3 endpoint.
::::
