---
description: 'How Atlas lays out a tenant S3 bucket: one bucket per tenant, with Outlook, onedrive/, sharepoint/, and _meta/ prefixes and encrypted objects.'
---

# Storage layout

Each tenant has its own S3 bucket, named `atlas-{tenant_id}`. Outlook data sits at the bucket root, contacts under `contacts/`, calendars under `calendar/`, OneDrive data under `onedrive/`, SharePoint data under `sharepoint/`, Teams data under `teams/`, and shared metadata under `_meta/`. Everything in the bucket is encrypted except the S3 object metadata described below and the [owner leases](#owner-leases).

```
atlas-{tenant_id}/
├── _meta/
│   ├── dek.enc                                  # wrapped data encryption key
│   ├── outlook-cursors/{owner_id}.json          # Outlook delta links, one per folder
│   ├── outlook-leases/{owner_id}.json           # owner lease, present while an operation runs
│   ├── outlook-manifests/
│   │   ├── owners/{owner_id}/latest.json        # latest manifest pointer per mailbox
│   │   ├── owners/{owner_id}/summary.json       # snapshot summary index per mailbox
│   │   └── snapshots/{snapshot_id}.json         # manifest key per snapshot
│   ├── replication/                             # replication status records
│   │   ├── {owner_id}/                          # Outlook
│   │   ├── onedrive/{owner_id}/                 # OneDrive
│   │   └── sharepoint/{site_id}/                # SharePoint
│   ├── storage-check/                           # probe object of `atlas storage-check`, removed at once
│   └── replica.marker                           # present only on replica buckets
├── _quarantine/{original_key}                    # damaged manifests and version indexes moved aside
├── identity-registry.json                       # resolved users, one per tenant
├── data/{owner_id}/{content_name}               # Outlook messages
├── attachments/{owner_id}/{content_name}        # Outlook attachments (legacy JSON entries)
├── manifests/{owner_id}/{snapshot_id}.json      # Outlook manifests
├── contacts/
│   ├── data/{owner_id}/{content_name}          # contact records, keyed HMAC-SHA256 name
│   ├── photos/{owner_id}/{content_name}        # contact photos, keyed HMAC-SHA256 name
│   ├── manifests/{owner_id}/{snapshot_id}.json # contacts manifests
│   ├── _meta/{owner_id}/delta.json             # delta cursor
│   ├── _meta/{owner_id}/snapshots.json         # snapshot summary index
│   └── _meta/{owner_id}/lease.json             # owner lease
├── calendar/
│   ├── data/{owner_id}/{content_name}          # event records, keyed HMAC-SHA256 name
│   ├── attachments/{owner_id}/{content_name}   # event file attachments, keyed HMAC-SHA256 name
│   ├── manifests/{owner_id}/{snapshot_id}.json # calendar manifests
│   ├── _meta/{owner_id}/delta.json             # delta cursors, one per calendar
│   ├── _meta/{owner_id}/snapshots.json         # snapshot summary index
│   └── _meta/{owner_id}/lease.json             # owner lease
├── onedrive/
│   ├── data/{owner_id}/{content_name}           # file blobs
│   ├── manifests/{owner_id}/{snapshot_id}.json
│   ├── index/{owner_id}/runs/{snapshot_id}.json # version index per backup run
│   ├── index/{owner_id}/files/{file_id}.json    # legacy per-file index
│   ├── staging/{owner_id}/                      # temporary multipart uploads
│   ├── _meta/{owner_id}/delta.json              # delta cursors
│   ├── _meta/{owner_id}/snapshots.json          # snapshot summary index
│   └── _meta/{owner_id}/lease.json              # owner lease
├── sharepoint/
│   ├── data/{site_id}/{content_name}
│   ├── manifests/{site_id}/{snapshot_id}.json
│   ├── index/{site_id}/runs/{snapshot_id}.json
│   ├── index/{site_id}/files/{file_id}.json
│   ├── staging/{site_id}/
│   ├── _meta/{site_id}/delta.json
│   ├── _meta/{site_id}/snapshots.json
│   └── _meta/{site_id}/lease.json
└── teams/
    ├── data/{team_id}/{content_name}
    ├── data/{team_id}/hosted/{content_name}
    ├── manifests/{team_id}/{snapshot_id}.json
    ├── shards/{team_id}/{channel_id}/{content_name}.json
    ├── _meta/{team_id}/channels/{channel_id}.json
    ├── _meta/{team_id}/checkpoints/{channel_id}/
    └── _meta/{team_id}/lease.json
```

## Quarantined objects

```
_quarantine/onedrive/manifests/{owner_id}/{snapshot_id}.json
_quarantine/manifests/{owner_id}/{snapshot_id}.json
_quarantine/teams/manifests/{team_id}/{snapshot_id}.json
```

`atlas <workload> quarantine --key <key>` moves a damaged snapshot manifest or version index to `_quarantine/` followed by its original key, so the workload prefixes no longer list it. The bytes are copied unchanged, so the object stays encrypted and bound to its original key: it does not decrypt at the quarantine key. A second quarantine of the same key adds a millisecond suffix rather than overwriting the first copy. See [Damaged manifests and version indexes](/reference/cli#damaged-manifests-and-version-indexes).

No backup, restore, listing, or verification reads `_quarantine/`. Deleting an owner, mailbox, site, or team removes its quarantined copies too, and `atlas delete --purge` removes the whole prefix. `atlas stats storage` counts the prefix as `other`, not under a workload.

## Owner leases

```
_meta/outlook-leases/{owner_id}.json     # Outlook mail
onedrive/_meta/{owner_id}/lease.json     # also contacts/, calendar/
sharepoint/_meta/{site_id}/lease.json
teams/_meta/{team_id}/lease.json
```

A backup, deletion, or quarantine holds one lease object for its mailbox, drive owner, site, or team while it runs, so two operations never write the same owner's cursor, pointer, summary index, or checkpoint at once. A restore of a mailbox, drive owner, or site holds the same lease, so a deletion cannot remove the snapshot it is restoring. The object sits next to the owner's delta cursor. See [Concurrent operations](/reference/sdk#concurrent-operations) for the protocol.

The lease is not encrypted. It is plain JSON, so that an operation without the tenant key, such as erasing an owner after the passphrase is lost, can still take it. Anyone with read access to the bucket can read:

| Field                       | What it reveals                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `operation`                 | That a `backup`, `delete`, `quarantine`, or `restore` is running on the owner, or last ran if the lease was left behind |
| `acquired_at`, `expires_at` | When that operation started and when it last renewed the lease, to the minute                                           |
| `released_at`               | When it finished, present only when the lease could not be deleted                                                      |
| `holder_id`                 | A random ID generated for that one run. It names no host, user, or process                                              |
| `format_version`            | The lease format                                                                                                        |

The owner ID is in the key, as it is for every object of that owner. The lease holds no backup content, no item names, and nothing derived from the tenant key.

| Property      | Behavior                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifetime      | Written when the operation starts, rewritten every 60 seconds, deleted when it ends. If the delete is refused, it is rewritten as released and stays as a free lease. One left by a killed process expires 5 minutes after its last write |
| Object Lock   | Never written with retention, also when the run uses `--retention-days`. A bucket default retention still locks each version, which is one more reason to remove it                                                                       |
| Versions      | In a versioned bucket every renewal leaves a noncurrent version of about 200 bytes. The 30-day noncurrent expiry rule removes them                                                                                                        |
| Deletion      | Deleting an owner removes its lease last, with all versions, so nothing is left under the erased owner's ID                                                                                                                               |
| Replication   | Never copied to a replica. A lease describes a run on this bucket                                                                                                                                                                         |
| Storage usage | Counted like a delta cursor: under its workload for the prefixed workloads, under `meta` for Outlook. It is not backup data                                                                                                               |

Do not delete a lease by hand while its operation may still be running. See [Another operation holds the owner](/troubleshooting#another-operation-holds-the-owner).

## Bucket isolation

Each tenant has a separate bucket, `atlas-<tenant_id>`, with its own `dek.enc` and its own Object Lock and lifecycle settings. The bucket is named after the tenant ID of the profile or SDK instance that writes it, so switching profiles switches buckets.

Bucket separation alone does not separate credentials. The CLI's [tenant profiles](/configuration#tenant-profiles) share one S3 access key and one passphrase, so that key can read every profile's bucket. Managed service providers that must give each customer access to its own bucket only should use one S3 key per tenant: a separate Atlas installation per customer, or one SDK instance per tenant with its own `s3AccessKey`, `s3SecretKey`, and `encryptionPassphrase`.

## Outlook

| Prefix                                         | Contents                                                  | Notes                                                                   |
| ---------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `_meta/dek.enc`                                | Wrapped data encryption key, one per tenant               | The most critical object. See [The DEK object](#the-dek-object).        |
| `_meta/outlook-cursors/{owner_id}.json`        | Delta cursor: one Graph delta link per mail folder        | Encrypted, bound to its owner. Overwritten by every run.                |
| `_meta/outlook-manifests/owners/{owner_id}/`   | Latest manifest pointer and snapshot summary index        | Lets backups and lists read one object, not the full history.           |
| `_meta/outlook-manifests/snapshots/{snapshot}` | Pointer from a snapshot ID to its manifest                | Direct lookup by snapshot ID.                                           |
| `data/{owner_id}/`                             | Messages as RFC 5322 MIME, named by keyed hash            | Content encrypted; S3 metadata visible.                                 |
| `attachments/{owner_id}/`                      | Attachments from legacy JSON entries, named by keyed hash | Content encrypted; S3 metadata visible.                                 |
| `manifests/{owner_id}/`                        | Snapshot manifests                                        | Include subjects, senders, folder names, and delta URLs, all encrypted. |

Pointers hold an encrypted manifest key. `latest.json` also holds the `created_at` of the manifest it names, so a backup can compare without decrypting that manifest. Before a backup replaces `latest.json`, it reads the current pointer and keeps it when it names a snapshot created later than the one being written. A slower run that finishes last therefore cannot point latest at an older snapshot. The backup logs a warning naming both snapshot IDs, and the older snapshot stays in the catalog. A missing, undecryptable, or older-format pointer is replaced as before, so a damaged pointer never blocks a backup. Deleting a mailbox or snapshot removes its pointers. The summary index is described in [Snapshot summary index](#snapshot-summary-index).

### Message formats

Each manifest entry declares how its message is stored.

- **MIME (`payload_format: "mime"`).** Snapshots taken by this version store the original MIME from Graph. Attachments travel inside the MIME, so these entries write no `attachments/` objects. Each entry records `received_at` when Graph or the MIME `Date` header provides it. Atlas omits the field rather than writing the backup time.
- **Legacy JSON.** Snapshots from earlier versions store Graph JSON, with each attachment as a separate object under `attachments/`. Their manifest entries have no `payload_format` field. They stay readable, restorable, verifiable, and exportable. A mailbox with history from before and after the upgrade has both kinds in one chain.

If Graph cannot return MIME for one message, Atlas stores that message in the legacy JSON form inside an otherwise MIME snapshot. Check `payload_format` to tell them apart.

### Shared mailboxes

Each Outlook manifest records `mailbox_purpose` (Graph's `mailboxSettings.userPurpose`, such as `user`, `shared`, or `room`) when the backup ran. Shared mailboxes are often unlicensed, so this field is how they show up in the backup catalog. Converting a user mailbox to a shared one keeps its Entra object ID, so its prefix stays the same. Older manifests report `user`, and later ones report `shared`. Manifests from before the field existed omit it.

## OneDrive and SharePoint

| Prefix                                     | Contents                                | Notes                                                                     |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| `onedrive/data/{owner_id}/`                | File blobs, named by keyed hash         | Owner is the Entra object ID.                                             |
| `onedrive/manifests/{owner_id}/`           | Snapshot manifests                      | Include file paths, checksums, and change types.                          |
| `onedrive/index/{owner_id}/runs/`          | One version index per backup run        | Maps file IDs to the versions that run captured.                          |
| `onedrive/index/{owner_id}/files/`         | Legacy per-file version indexes         | Still readable. Removed only by purging the owner.                        |
| `onedrive/_meta/{owner_id}/delta.json`     | Delta cursors                           | Include delta links, file paths and names, ETags, and version watermarks. |
| `onedrive/_meta/{owner_id}/snapshots.json` | Snapshot summary index                  | See [Snapshot summary index](#snapshot-summary-index).                    |
| `sharepoint/...`                           | The same layout, keyed by Graph site ID | Site ID replaces owner ID.                                                |

### Version indexes

Each backup run writes one version index object per owner or site, under `runs/`. A run with no new versions writes none. Objects under `files/` came from earlier versions and remain readable. Listing history reads both layouts. History stays listable and verifiable until the bucket is purged.

Reading history costs one request per index object, so it grows with the number of runs. Backups do not read indexes. They use a watermark in the delta cursor, described in [Delta sync](/operations/delta-sync#file-version-capture-onedrive-and-sharepoint). Only `atlas onedrive versions`, `atlas sharepoint versions`, and snapshot verification read the indexes.

The first backup after an upgrade is the exception. Existing cursors have no watermark, so that backup scans the legacy `files/` objects once to seed it. Each legacy file is one object, so a drive with 20,000 files means 20,000 objects in that scan. Later backups skip the scan.

### Subsites

A subsite has its own Graph `site_id`, so `atlas sharepoint backup --include-subsites` writes a separate snapshot under the subsite's own prefix. Its blobs, indexes, and cursors follow the same split. Backup, restore, and retention for a subsite are independent of its parent.

## Snapshot summary index

```bash
atlas onedrive list-snapshots -o user@example.com   # one LIST, one summary read, no manifest decrypted
atlas onedrive status -o user@example.com           # decrypts only the newest manifest
```

Outlook, OneDrive, SharePoint, Contacts, and Calendar keep one summary object per mailbox, drive owner, or site. It lists every snapshot with its ID, `created_at`, manifest key, entry count, size, and item totals (messages, files, contacts, or events), plus the owner's address or site name and, for Outlook, the removal count and effective Object Lock retention. It holds no entries. A manifest carries every entry of its run, so before the index `status`, `list`, and `stats` downloaded and decrypted every manifest of the owner. With the index they read one small object, and a restore, save, verify, or `read` decrypts only the manifests its chain needs: a `read` by message index decrypts the target manifest alone, and a chain never decrypts snapshots newer than its target.

| Workload   | Key                                                      |
| ---------- | -------------------------------------------------------- |
| Outlook    | `_meta/outlook-manifests/owners/{owner_id}/summary.json` |
| OneDrive   | `onedrive/_meta/{owner_id}/snapshots.json`               |
| SharePoint | `sharepoint/_meta/{site_id}/snapshots.json`              |
| Contacts   | `contacts/_meta/{owner_id}/snapshots.json`               |
| Calendar   | `calendar/_meta/{owner_id}/snapshots.json`               |

**Encryption.** The summary is AES-256-GCM encrypted with the tenant DEK and bound to its directory, like the manifest pointers. The body also names its owner, and a reader ignores a summary that names another one, so a summary copied from one owner's directory to another's is not used. A row is used only when its manifest key is the key its own owner and snapshot ID build. The index adds no new plaintext to the bucket: the same fields are already inside the encrypted manifests.

**Write order.** A backup writes the manifest first, then the Outlook pointers, then rewrites the summary, then the delta cursor. The summary is written only after the manifest's create-only write and its read-back succeeded, so it never names a manifest that failed to store. If the summary write fails, the backup still succeeds and logs a warning, because the manifest is the record. The write is conditional: `If-None-Match` creates the summary, `If-Match` on the ETag that was read replaces it. When another writer changed it in between, Atlas reads, reconciles, and writes once more, then gives up with a warning. A backend that ignores conditional headers lets the later write win, which leaves a stale summary at worst.

The summary goes through the same [guarded writer](/security#metadata-is-checked-before-and-after-it-is-stored) as the manifests, without the read-back. The run checks its [owner lease](#owner-leases) again right before the write, because seeding rows on the first backup after an upgrade decrypts every older manifest and can take long. A run that lost the lease raises `OwnerLeaseLostError` there and writes neither the summary nor the cursor.

**The listing decides what exists.** Every read lists the owner's manifest keys, which it did before the index, and reconciles them with the summary rows:

- A key with a row is answered from the row, without decrypting the manifest.
- A key without a row is decrypted and summarised. This covers a summary write that failed, a rehydrate from a replica, and data written before the index existed.
- A row whose key is gone is dropped. This covers lifecycle expiry, which never touches the summary, and a `delete -s` or `quarantine` whose own prune of the row failed.
- A summary that is missing, fails to decrypt, names another owner, or has an unknown `format_version` counts as empty, so the read decrypts every manifest as earlier releases did.

A stale summary therefore costs reads, never a wrong answer. Readers never write the repair back, since `list` and `status` may run with read-only credentials or against a locked bucket. The next backup's summary write records the missing rows. The first backup of an owner after upgrading decrypts that owner's older manifests once to seed the summary.

::: warning Lists and status do not detect damage at rest
A manifest damaged after its row was written still appears in `list-snapshots`, `outlook list -m`, OneDrive and SharePoint `stats`, and `status`, because those answer from the row. Only a manifest without a row is decrypted and named as unreadable. `verify` reads every manifest in the chain and is the check for damage at rest. Restore, save, and `read` report a damaged manifest when they need it.
:::

`delete -s` and `quarantine` remove the snapshot's row under the owner's lease, after the manifest is gone and, for `delete -s`, after the delta cursor. Contacts and Calendar `delete -s` is the exception: it runs without the tenant key, so it cannot decrypt the summary to rewrite it. It leaves the row, readers drop it, and the next backup removes it. The rewrite is a compare-and-swap on the summary just read and never creates a summary. If it fails, the command still succeeds with a warning, and readers skip the row. Deleting an owner, mailbox, or site removes its summary along with its other `_meta` objects, and its lease last. During a OneDrive or SharePoint backup with Object Lock retention, the summary is written with the run's retention like the delta cursor, so each rewrite keeps a locked version until it expires. Replicas do not receive the summary, so reads against a replica decrypt every manifest.

Some reads still decrypt every manifest: Outlook `stats` and the all-mailbox `atlas outlook list`, which count messages across the merged chain, recrawl tombstones, and replication of every snapshot. Contacts and Calendar `list -m` answers from the index, but their `listSnapshots` SDK call returns whole manifests and still decrypts every one. Their backups already read only the newest.

## Teams

Teams data sits under `teams/`, keyed by Graph team ID. Message and reply blobs live under `teams/data/{team_id}/`, inline images under `teams/data/{team_id}/hosted/`, and snapshot indexes under `teams/manifests/{team_id}/`. Channel shards sit under `teams/shards/{team_id}/{channel_id}/`, per-channel delta cursors under `teams/_meta/{team_id}/channels/`, and the checkpoints of an unfinished channel read under `teams/_meta/{team_id}/checkpoints/{channel_id}/`. Teams writes no version index or staging objects.

## Contacts

| Prefix                                     | Contents                                            | Notes                                                                                    |
| ------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `contacts/data/{owner_id}/`                | Contact records as JSON, named by keyed HMAC-SHA256 | Owner is the Entra object ID. The manifest keeps the plain SHA-256 for integrity checks. |
| `contacts/photos/{owner_id}/`              | Contact photo bytes, named by keyed HMAC-SHA256     | Identical photos are stored once per mailbox.                                            |
| `contacts/manifests/{owner_id}/`           | Snapshot manifests                                  | Each manifest is complete. Snapshots do not chain to older ones.                         |
| `contacts/_meta/{owner_id}/delta.json`     | Delta cursor                                        | Graph delta link used by the next backup.                                                |
| `contacts/_meta/{owner_id}/snapshots.json` | Snapshot summary index                              | See [Snapshot summary index](#snapshot-summary-index).                                   |

## Calendar

| Prefix                                     | Contents                                          | Notes                                                                                    |
| ------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `calendar/data/{owner_id}/`                | Event records as JSON, named by keyed HMAC-SHA256 | Owner is the Entra object ID. The manifest keeps the plain SHA-256 for integrity checks. |
| `calendar/attachments/{owner_id}/`         | File attachment bytes, named by keyed HMAC-SHA256 | Only file attachments are stored. Item and reference attachments are not captured.       |
| `calendar/manifests/{owner_id}/`           | Snapshot manifests                                | Each manifest is complete. Snapshots do not chain to older ones.                         |
| `calendar/_meta/{owner_id}/delta.json`     | Delta cursors                                     | One Graph delta link per calendar, used by the next backup.                              |
| `calendar/_meta/{owner_id}/snapshots.json` | Snapshot summary index                            | See [Snapshot summary index](#snapshot-summary-index).                                   |

## The DEK object

`_meta/dek.enc` holds the **data encryption key (DEK)**, wrapped with a key encryption key (KEK) derived from your passphrase. Without it, no message can be decrypted, no manifest can be read, and no restore is possible.

If the file is lost or corrupted and you have no separate copy, every object in the bucket becomes permanently unreadable. Protect it:

- Restrict `DeleteObject` on `_meta/*` in the bucket policy.
- Enable Object Lock with a long retention on this key.
- Check periodically that the file exists and can be read.

With `DeleteObject` denied on `_meta/*`, Atlas cannot delete the Outlook [owner lease](#owner-leases) under `_meta/outlook-leases/` and marks it released in place instead, so the next run on that mailbox still starts at once.

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
