---
description: 'How Atlas lays out a tenant S3 bucket: one bucket per tenant, with Outlook, onedrive/, sharepoint/, and _meta/ prefixes and encrypted objects.'
---

# Storage layout

Each tenant has its own S3 bucket, named `atlas-{tenant_id}`. Outlook data sits at the bucket root, contacts under `contacts/`, calendars under `calendar/`, OneDrive data under `onedrive/`, SharePoint data under `sharepoint/`, Teams data under `teams/`, and shared metadata under `_meta/`. Everything in the bucket is encrypted except the S3 object metadata described below.

```
atlas-{tenant_id}/
├── _meta/
│   ├── dek.enc                                  # wrapped data encryption key
│   ├── outlook-cursors/{owner_id}.json          # Outlook delta links, one per folder
│   ├── outlook-manifests/
│   │   ├── owners/{owner_id}/latest.json        # latest manifest key per mailbox
│   │   └── snapshots/{snapshot_id}.json         # manifest key per snapshot
│   ├── replication/                             # replication status records
│   │   ├── {owner_id}/                          # Outlook
│   │   ├── onedrive/{owner_id}/                 # OneDrive
│   │   └── sharepoint/{site_id}/                # SharePoint
│   └── replica.marker                           # present only on replica buckets
├── identity-registry.json                       # resolved users, one per tenant
├── data/{owner_id}/{content_name}               # Outlook messages
├── attachments/{owner_id}/{content_name}        # Outlook attachments (legacy JSON entries)
├── manifests/{owner_id}/{snapshot_id}.json      # Outlook manifests
├── contacts/
│   ├── data/{owner_id}/{content_name}          # contact records, keyed HMAC-SHA256 name
│   ├── photos/{owner_id}/{content_name}        # contact photos, keyed HMAC-SHA256 name
│   ├── manifests/{owner_id}/{snapshot_id}.json # contacts manifests
│   └── _meta/{owner_id}/delta.json             # delta cursor
├── calendar/
│   ├── data/{owner_id}/{content_name}          # event records, keyed HMAC-SHA256 name
│   ├── attachments/{owner_id}/{content_name}   # event file attachments, keyed HMAC-SHA256 name
│   ├── manifests/{owner_id}/{snapshot_id}.json # calendar manifests
│   └── _meta/{owner_id}/delta.json             # delta cursors, one per calendar
├── onedrive/
│   ├── data/{owner_id}/{content_name}           # file blobs
│   ├── manifests/{owner_id}/{snapshot_id}.json
│   ├── index/{owner_id}/runs/{snapshot_id}.json # version index per backup run
│   ├── index/{owner_id}/files/{file_id}.json    # legacy per-file index
│   ├── staging/{owner_id}/                      # temporary multipart uploads
│   └── _meta/{owner_id}/delta.json              # delta cursors
├── sharepoint/
│   ├── data/{site_id}/{content_name}
│   ├── manifests/{site_id}/{snapshot_id}.json
│   ├── index/{site_id}/runs/{snapshot_id}.json
│   ├── index/{site_id}/files/{file_id}.json
│   ├── staging/{site_id}/
│   └── _meta/{site_id}/delta.json
└── teams/
    ├── data/{team_id}/{content_name}
    ├── data/{team_id}/hosted/{content_name}
    ├── manifests/{team_id}/{snapshot_id}.json
    ├── shards/{team_id}/{channel_id}/{content_name}.json
    ├── _meta/{team_id}/channels/{channel_id}.json
    └── _meta/{team_id}/checkpoints/{channel_id}/
```

## Bucket isolation

Each tenant has a separate bucket, `atlas-<tenant_id>`, with its own `dek.enc` and its own Object Lock and lifecycle settings. The bucket is named after the tenant ID of the profile or SDK instance that writes it, so switching profiles switches buckets.

Bucket separation alone does not separate credentials. The CLI's [tenant profiles](/configuration#tenant-profiles) share one S3 access key and one passphrase, so that key can read every profile's bucket. Managed service providers that must give each customer access to its own bucket only should use one S3 key per tenant: a separate Atlas installation per customer, or one SDK instance per tenant with its own `s3AccessKey`, `s3SecretKey`, and `encryptionPassphrase`.

## Outlook

| Prefix                                         | Contents                                                  | Notes                                                                   |
| ---------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `_meta/dek.enc`                                | Wrapped data encryption key, one per tenant               | The most critical object. See [The DEK object](#the-dek-object).        |
| `_meta/outlook-cursors/{owner_id}.json`        | Delta cursor: one Graph delta link per mail folder        | Encrypted, bound to its owner. Overwritten by every run.                |
| `_meta/outlook-manifests/owners/{owner_id}/`   | Pointer to the latest manifest for a mailbox              | Lets incremental backups read one manifest, not the full history.       |
| `_meta/outlook-manifests/snapshots/{snapshot}` | Pointer from a snapshot ID to its manifest                | Direct lookup by snapshot ID.                                           |
| `data/{owner_id}/`                             | Messages as RFC 5322 MIME, named by keyed hash            | Content encrypted; S3 metadata visible.                                 |
| `attachments/{owner_id}/`                      | Attachments from legacy JSON entries, named by keyed hash | Content encrypted; S3 metadata visible.                                 |
| `manifests/{owner_id}/`                        | Snapshot manifests                                        | Include subjects, senders, folder names, and delta URLs, all encrypted. |

Pointers hold only an encrypted manifest key. Deleting a mailbox or snapshot removes its pointers.

### Message formats

Each manifest entry declares how its message is stored.

- **MIME (`payload_format: "mime"`).** Snapshots taken by this version store the original MIME from Graph. Attachments travel inside the MIME, so these entries write no `attachments/` objects. Each entry records `received_at` when Graph or the MIME `Date` header provides it. Atlas omits the field rather than writing the backup time.
- **Legacy JSON.** Snapshots from earlier versions store Graph JSON, with each attachment as a separate object under `attachments/`. Their manifest entries have no `payload_format` field. They stay readable, restorable, verifiable, and exportable. A mailbox with history from before and after the upgrade has both kinds in one chain.

If Graph cannot return MIME for one message, Atlas stores that message in the legacy JSON form inside an otherwise MIME snapshot. Check `payload_format` to tell them apart.

### Shared mailboxes

Each Outlook manifest records `mailbox_purpose` (Graph's `mailboxSettings.userPurpose`, such as `user`, `shared`, or `room`) when the backup ran. Shared mailboxes are often unlicensed, so this field is how they show up in the backup catalog. Converting a user mailbox to a shared one keeps its Entra object ID, so its prefix stays the same. Older manifests report `user`, and later ones report `shared`. Manifests from before the field existed omit it.

## OneDrive and SharePoint

| Prefix                                 | Contents                                | Notes                                                                     |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `onedrive/data/{owner_id}/`            | File blobs, named by keyed hash         | Owner is the Entra object ID.                                             |
| `onedrive/manifests/{owner_id}/`       | Snapshot manifests                      | Include file paths, checksums, and change types.                          |
| `onedrive/index/{owner_id}/runs/`      | One version index per backup run        | Maps file IDs to the versions that run captured.                          |
| `onedrive/index/{owner_id}/files/`     | Legacy per-file version indexes         | Still readable. Removed only by purging the owner.                        |
| `onedrive/_meta/{owner_id}/delta.json` | Delta cursors                           | Include delta links, file paths and names, ETags, and version watermarks. |
| `sharepoint/...`                       | The same layout, keyed by Graph site ID | Site ID replaces owner ID.                                                |

### Version indexes

Each backup run writes one version index object per owner or site, under `runs/`. A run with no new versions writes none. Objects under `files/` came from earlier versions and remain readable. Listing history reads both layouts. History stays listable and verifiable until the bucket is purged.

Reading history costs one request per index object, so it grows with the number of runs. Backups do not read indexes. They use a watermark in the delta cursor, described in [Delta sync](/operations/delta-sync#file-version-capture-onedrive-and-sharepoint). Only `atlas onedrive versions`, `atlas sharepoint versions`, and snapshot verification read the indexes.

The first backup after an upgrade is the exception. Existing cursors have no watermark, so that backup scans the legacy `files/` objects once to seed it. Each legacy file is one object, so a drive with 20,000 files means 20,000 objects in that scan. Later backups skip the scan.

### Subsites

A subsite has its own Graph `site_id`, so `atlas sharepoint backup --include-subsites` writes a separate snapshot under the subsite's own prefix. Its blobs, indexes, and cursors follow the same split. Backup, restore, and retention for a subsite are independent of its parent.

## Teams

Teams data sits under `teams/`, keyed by Graph team ID. Message and reply blobs live under `teams/data/{team_id}/`, inline images under `teams/data/{team_id}/hosted/`, and snapshot indexes under `teams/manifests/{team_id}/`. Channel shards sit under `teams/shards/{team_id}/{channel_id}/`, per-channel delta cursors under `teams/_meta/{team_id}/channels/`, and the checkpoints of an unfinished channel read under `teams/_meta/{team_id}/checkpoints/{channel_id}/`. Teams writes no version index or staging objects.

## Contacts

| Prefix                                 | Contents                                            | Notes                                                                                    |
| -------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `contacts/data/{owner_id}/`            | Contact records as JSON, named by keyed HMAC-SHA256 | Owner is the Entra object ID. The manifest keeps the plain SHA-256 for integrity checks. |
| `contacts/photos/{owner_id}/`          | Contact photo bytes, named by keyed HMAC-SHA256     | Identical photos are stored once per mailbox.                                            |
| `contacts/manifests/{owner_id}/`       | Snapshot manifests                                  | Each manifest is complete. Snapshots do not chain to older ones.                         |
| `contacts/_meta/{owner_id}/delta.json` | Delta cursor                                        | Graph delta link used by the next backup.                                                |

## Calendar

| Prefix                                 | Contents                                          | Notes                                                                                    |
| -------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `calendar/data/{owner_id}/`            | Event records as JSON, named by keyed HMAC-SHA256 | Owner is the Entra object ID. The manifest keeps the plain SHA-256 for integrity checks. |
| `calendar/attachments/{owner_id}/`     | File attachment bytes, named by keyed HMAC-SHA256 | Only file attachments are stored. Item and reference attachments are not captured.       |
| `calendar/manifests/{owner_id}/`       | Snapshot manifests                                | Each manifest is complete. Snapshots do not chain to older ones.                         |
| `calendar/_meta/{owner_id}/delta.json` | Delta cursors                                     | One Graph delta link per calendar, used by the next backup.                              |

## The DEK object

`_meta/dek.enc` holds the **data encryption key (DEK)**, wrapped with a key encryption key (KEK) derived from your passphrase. Without it, no message can be decrypted, no manifest can be read, and no restore is possible.

If the file is lost or corrupted and you have no separate copy, every object in the bucket becomes permanently unreadable. Protect it:

- Restrict `DeleteObject` on `_meta/*` in the bucket policy.
- Enable Object Lock with a long retention on this key.
- Check periodically that the file exists and can be read.

## Content addressing

Messages, attachments, and files are named by an HMAC-SHA256 of their **plaintext**, computed before encryption and keyed with a naming key derived from the tenant data key. Identical content within an owner gets the same name and is stored once, so a message that appears in several snapshots is one object. Each manifest records the object's key and a plain SHA-256 checksum of the plaintext. Integrity checks decrypt the object, hash the result with SHA-256, and compare it with the manifest checksum. A match proves the content is byte-for-byte what was backed up.

Objects written before keyed naming are named by the plain SHA-256 of their plaintext. They stay readable through their manifest entries. See [What object names reveal](/security#what-object-names-reveal).

MIME changes the deduplication boundary for messages. Two messages with the same attachment are two blobs, so the attachment is stored once per message rather than once per mailbox. MIME also encodes attachments in base64, which adds about one third to their size. Atlas accepts that cost because it keeps messages byte-exact, which matters for signed mail.

## S3 object metadata

Mailbox objects carry these headers:

| Header                    | Value                                   | Encrypted                 |
| ------------------------- | --------------------------------------- | ------------------------- |
| `x-amz-meta-x-message-id` | Microsoft Graph message ID              | No, visible to S3 readers |
| `Content-MD5`             | MD5 of the ciphertext (transport check) | Standard S3 header        |

Objects written before keyed naming also carry `x-amz-meta-x-plaintext-sha256`, the SHA-256 of the plaintext. Atlas no longer writes or reads it.

::: warning Metadata reveals existence
Anyone with S3 read access can list Graph message IDs. The content stays encrypted, but the metadata shows which messages exist. If that exposure is not acceptable, limit the bucket to the Atlas service account and restrict the network path to the S3 endpoint.
:::

## See also

- [Replication](/operations/replication): copies these objects to a target
- [Immutability](/operations/immutability): Object Lock and lifecycle rules
- [Storage setup](/self-hosting/storage): creating the bucket
