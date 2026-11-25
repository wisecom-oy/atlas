---
description: 'How Atlas lays out a tenant S3 bucket: one bucket per tenant, a prefix per workload, and the encrypted objects inside each.'
---

# Storage layout

This page lists every object Atlas writes to a tenant bucket, for when you inspect a bucket, write a bucket policy, or plan a copy.

## How a tenant bucket is organised

Each Microsoft 365 tenant has its own bucket, `atlas-{tenant_id}`. Inside it, each workload has its own prefix, and each mailbox, drive owner, site, or team has its own folder under that prefix, named by its Microsoft ID.

| Prefix | Holds |
| --- | --- |
| bucket root (`data/`, `attachments/`, `manifests/`) | Outlook mail |
| `contacts/` | Outlook contacts |
| `calendar/` | Outlook calendars |
| `onedrive/` | OneDrive |
| `sharepoint/` | SharePoint |
| `teams/` | Teams |
| `_meta/` | Tenant-wide metadata, such as the wrapped data key, and Outlook mail's metadata |
| `_quarantine/` | Damaged manifests and version indexes moved aside |

Within a workload, the same kinds of object recur:

| Kind | Path pattern | What it is |
| --- | --- | --- |
| Content | `data/{owner}/{content_name}` | One object per unique message, file, or record. Stored once and shared by every snapshot that contains it |
| Manifest | `manifests/{owner}/{snapshot_id}.json` | One per snapshot: the list of what that backup captured |
| Metadata | `_meta/{owner}/...` | The sync checkpoint for the next incremental backup, the snapshot summary index, and the owner lease |

Everything in the bucket is encrypted except the [S3 object metadata](#s3-object-metadata) and the [owner leases](#owner-leases).

```text
atlas-{tenant_id}/
├── _meta/
│   ├── dek.enc                                  # wrapped data encryption key
│   ├── outlook-cursors/{owner_id}.json          # Outlook delta links, one per folder
│   ├── outlook-leases/{owner_id}.json           # owner lease, present while an operation runs
│   ├── tenant-lease.json                        # tenant lease, present while a purge or key re-wrap runs
│   ├── outlook-manifests/
│   │   ├── owners/{owner_id}/latest.json        # latest manifest pointer per mailbox
│   │   ├── owners/{owner_id}/summary.json       # snapshot summary index per mailbox
│   │   └── snapshots/{snapshot_id}.json         # manifest key per snapshot
│   ├── replication/                             # replication status records written by Atlas 6, inert
│   │   ├── {owner_id}/                          # Outlook
│   │   ├── onedrive/{owner_id}/                 # OneDrive
│   │   └── sharepoint/{site_id}/                # SharePoint
│   ├── storage-check/                           # probe object of `atlas storage-check`, removed at once
│   └── replica.marker                           # written by Atlas 6 on its replicas, inert
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

In the tree, "delta cursor" is the sync checkpoint (a Microsoft Graph delta link) that the next incremental backup starts from.

## Bucket isolation

Each tenant has a separate bucket, `atlas-<tenant_id>`, with its own `dek.enc` and its own Object Lock and lifecycle settings. The bucket is named after the tenant ID of the profile or SDK instance that writes it, so switching profiles switches buckets.

A [bucket override](/configuration#bucket-override) (`ATLAS_S3_BUCKET`, a profile's `bucket`, or the SDK's `s3Bucket`) replaces the name, not the layout: the bucket must hold a copy of the same tenant's objects, under the same keys. The override is bound to the tenant it was configured for. Atlas never creates an overridden bucket, so it adds no Object Lock or lifecycle settings to it. Configure those when you create it.

::: warning Separate buckets do not mean separate credentials
The CLI's [tenant profiles](/configuration#tenant-profiles) share one S3 access key and one passphrase, so that key can read every profile's bucket. A managed service provider that must give each customer access to its own bucket only should use one S3 key per tenant: a separate Atlas installation per customer, or one SDK instance per tenant with its own `s3AccessKey`, `s3SecretKey`, and `encryptionPassphrase`.
:::

## Tenant-wide objects

| Key | Contents | Notes |
| --- | --- | --- |
| `_meta/dek.enc` | Wrapped data encryption key, one per tenant | The most critical object. See [The DEK object](#the-dek-object) |
| `identity-registry.json` | Every user a backup looked up by email | Encrypted. The only record of departed users Microsoft 365 no longer resolves |
| `_meta/tenant-lease.json` | Tenant lease | Present while a purge or key re-wrap runs. See [Owner leases](#owner-leases) |
| `_meta/storage-check/` | Probe object of `atlas storage-check` | Removed at once |
| `_quarantine/` | Quarantined manifests and version indexes | See [Quarantined objects](#quarantined-objects) |

## Outlook

| Prefix | Contents | Notes |
| --- | --- | --- |
| `_meta/outlook-cursors/{owner_id}.json` | Delta cursor: one Graph delta link per mail folder | Encrypted, bound to its owner. Overwritten by every run |
| `_meta/outlook-manifests/owners/{owner_id}/` | Latest manifest pointer (`latest.json`) and snapshot summary index (`summary.json`) | Lets backups and lists read one object, not the full history |
| `_meta/outlook-manifests/snapshots/{snapshot}` | Pointer from a snapshot ID to its manifest | Direct lookup by snapshot ID |
| `_meta/outlook-leases/{owner_id}.json` | Owner lease | See [Owner leases](#owner-leases) |
| `data/{owner_id}/` | Messages as RFC 5322 MIME, named by keyed hash | Content encrypted; S3 metadata visible |
| `attachments/{owner_id}/` | Attachments from legacy JSON entries, named by keyed hash | Content encrypted; S3 metadata visible |
| `manifests/{owner_id}/` | Snapshot manifests | Include subjects, senders, folder names, and delta URLs, all encrypted |

Pointers hold an encrypted manifest key. `latest.json` also holds the `created_at` of the manifest it names. A backup never moves `latest.json` back to an older snapshot: when the current pointer names a snapshot created later than the one being written, as when a slower run finishes last, the backup keeps it, logs a warning naming both snapshot IDs, and the older snapshot stays in the catalog. A missing, undecryptable, or older-format pointer is replaced, so a damaged pointer never blocks a backup. Deleting a mailbox or snapshot removes its pointers. The summary index is described in [Snapshot summary index](#snapshot-summary-index).

### Message formats

Each manifest entry declares how its message is stored:

| Format | Manifest entry | Attachments |
| --- | --- | --- |
| MIME | `payload_format: "mime"`. The original MIME from Microsoft Graph | Inside the MIME. No `attachments/` objects |
| Legacy JSON | No `payload_format` field. Graph JSON, from snapshots taken by earlier versions | One object each under `attachments/` |

Legacy JSON entries stay readable, restorable, verifiable, and exportable, and a mailbox can have both kinds in one chain. If Microsoft Graph cannot return MIME for a message, Atlas stores that one message as JSON inside an otherwise MIME snapshot. Check `payload_format` to tell them apart.

A MIME entry records `received_at` when Microsoft Graph or the MIME `Date` header provides it. Atlas omits the field rather than writing the backup time.

### Shared mailboxes

Each Outlook manifest records `mailbox_purpose` (Graph's `mailboxSettings.userPurpose`, such as `user`, `shared`, or `room`) at the time of the backup. Shared mailboxes are often unlicensed, so this field is how they show up in the backup catalog. Converting a user mailbox to a shared one keeps its Entra object ID and so its prefix: older manifests report `user` and later ones `shared`. Manifests written before the field existed omit it.

## OneDrive and SharePoint

| Prefix | Contents | Notes |
| --- | --- | --- |
| `onedrive/data/{owner_id}/` | File blobs, named by keyed hash | Owner is the Entra object ID |
| `onedrive/manifests/{owner_id}/` | Snapshot manifests | Include file paths, checksums, and change types |
| `onedrive/index/{owner_id}/runs/` | One version index per backup run | Maps file IDs to the versions that run captured |
| `onedrive/index/{owner_id}/files/` | Legacy per-file version indexes | Still readable. Removed only by purging the owner |
| `onedrive/staging/{owner_id}/` | Temporary multipart uploads of large files | Moved to `data/` when the upload completes |
| `onedrive/_meta/{owner_id}/delta.json` | Delta cursors | Include delta links, file paths and names, ETags, and version watermarks |
| `onedrive/_meta/{owner_id}/snapshots.json` | Snapshot summary index | See [Snapshot summary index](#snapshot-summary-index) |
| `onedrive/_meta/{owner_id}/lease.json` | Owner lease | See [Owner leases](#owner-leases) |
| `sharepoint/...` | The same layout, keyed by Graph site ID | Site ID replaces owner ID |

### Version indexes

Each backup run writes one version index object per owner or site, under `runs/`. A run with no new versions writes none. Objects under `files/` are from earlier versions and stay readable. Listing history reads both layouts, and history stays listable and verifiable until the bucket is purged.

Only `atlas onedrive versions`, `atlas sharepoint versions`, and snapshot verification read the indexes, at one request per index object, so the cost grows with the number of runs. Backups use a watermark in the delta cursor instead, described in [Delta sync](/operations/delta-sync#file-version-capture-onedrive-and-sharepoint).

::: details First backup of a drive with legacy indexes
A cursor written before watermarks existed has none, so the first backup that finds such a cursor scans the legacy `files/` objects once to seed it. Each legacy file is one object, so a drive with 20,000 files means 20,000 objects in that scan. Later backups skip it.
:::

### Subsites

A subsite has its own Graph `site_id`, so `atlas sharepoint backup --include-subsites` writes a separate snapshot under the subsite's own prefix, with its own blobs, indexes, and cursors. Backup, restore, and retention for a subsite are independent of its parent.

## Teams

Teams data sits under `teams/`, keyed by Graph team ID. Teams writes no version index or staging objects.

| Prefix | Contents |
| --- | --- |
| `teams/data/{team_id}/` | Message and reply blobs |
| `teams/data/{team_id}/hosted/` | Inline images |
| `teams/manifests/{team_id}/` | Snapshot indexes |
| `teams/shards/{team_id}/{channel_id}/` | Channel shards |
| `teams/_meta/{team_id}/channels/` | Per-channel delta cursors |
| `teams/_meta/{team_id}/checkpoints/{channel_id}/` | Checkpoints of an unfinished channel read |
| `teams/_meta/{team_id}/lease.json` | Owner lease |

## Contacts

| Prefix | Contents | Notes |
| --- | --- | --- |
| `contacts/data/{owner_id}/` | Contact records as JSON, named by keyed HMAC-SHA256 | Owner is the Entra object ID. The manifest keeps the plain SHA-256 for integrity checks |
| `contacts/photos/{owner_id}/` | Contact photo bytes, named by keyed HMAC-SHA256 | Identical photos are stored once per mailbox |
| `contacts/manifests/{owner_id}/` | Snapshot manifests | Each manifest is complete. Snapshots do not chain to older ones |
| `contacts/_meta/{owner_id}/delta.json` | Delta cursor | Graph delta link used by the next backup |
| `contacts/_meta/{owner_id}/snapshots.json` | Snapshot summary index | See [Snapshot summary index](#snapshot-summary-index) |
| `contacts/_meta/{owner_id}/lease.json` | Owner lease | See [Owner leases](#owner-leases) |

## Calendar

| Prefix | Contents | Notes |
| --- | --- | --- |
| `calendar/data/{owner_id}/` | Event records as JSON, named by keyed HMAC-SHA256 | Owner is the Entra object ID. The manifest keeps the plain SHA-256 for integrity checks |
| `calendar/attachments/{owner_id}/` | File attachment bytes, named by keyed HMAC-SHA256 | Only file attachments are stored. Item and reference attachments are not captured |
| `calendar/manifests/{owner_id}/` | Snapshot manifests | Each manifest is complete. Snapshots do not chain to older ones |
| `calendar/_meta/{owner_id}/delta.json` | Delta cursors | One Graph delta link per calendar, used by the next backup |
| `calendar/_meta/{owner_id}/snapshots.json` | Snapshot summary index | See [Snapshot summary index](#snapshot-summary-index) |
| `calendar/_meta/{owner_id}/lease.json` | Owner lease | See [Owner leases](#owner-leases) |

## Snapshot summary index

```bash
atlas onedrive list-snapshots -o user@example.com   # one LIST, one summary read, no manifest decrypted
atlas onedrive status -o user@example.com           # decrypts only the newest manifest
```

Outlook, OneDrive, SharePoint, Contacts, and Calendar keep one summary object per mailbox, drive owner, or site. It lets `status`, `list`, and `stats` read one small object instead of decrypting every manifest of the owner.

| Workload | Key |
| --- | --- |
| Outlook | `_meta/outlook-manifests/owners/{owner_id}/summary.json` |
| OneDrive | `onedrive/_meta/{owner_id}/snapshots.json` |
| SharePoint | `sharepoint/_meta/{site_id}/snapshots.json` |
| Contacts | `contacts/_meta/{owner_id}/snapshots.json` |
| Calendar | `calendar/_meta/{owner_id}/snapshots.json` |

The summary lists every snapshot with its ID, `created_at`, manifest key, entry count, size, and item totals (messages, files, contacts, or events), plus the owner's address or site name and, for Outlook, the removal count and effective Object Lock retention. It holds no entries and no message IDs in the clear.

A restore, save, verify, or `read` decrypts only the manifests its chain needs. A `read` by message index decrypts the target manifest alone, and a chain never decrypts snapshots newer than its target.

::: warning Lists and status do not detect damage at rest
A manifest damaged after its row was written still appears in `list-snapshots`, `outlook list`, `outlook list -m`, `stats`, `stats storage`, and `status`, because those answer from the row. Only a manifest without a row is decrypted and named as unreadable. `verify` reads every manifest in the chain and is the check for damage at rest. Restore, save, and `read` report a damaged manifest when they need it.
:::

### Outlook rows

An Outlook row also holds the figures the mailbox overview and `stats` sum, computed from the manifest when the backup saves it: message and attachment bytes, and per-folder counts and sizes. It also holds the object IDs of the snapshot's entries and removals, each reduced to a 96-bit SHA-256 prefix (16 characters). From these, `atlas outlook list` derives a mailbox's merged object count from the rows alone: a message counts once, at its newest appearance, and a removal hides the same ID in every older snapshot.

A row written by an earlier release has none of these fields. The overview, `stats`, and `stats storage` decrypt that one manifest until the next backup that stores a snapshot rewrites the row.

### How reads reconcile the index

Every read lists the owner's manifest keys and reconciles them with the summary rows. The listing decides what exists:

| Situation | What the read does |
| --- | --- |
| Key with a row | Answers from the row, without decrypting the manifest |
| Key without a row | Decrypts and summarises the manifest. Covers a failed summary write, a bucket copied without its summaries, and data written before the index existed |
| Row whose key is gone | Drops the row. Covers lifecycle expiry, which never touches the summary, and a `delete -s` or `quarantine` whose own prune of the row failed |
| Summary missing, undecryptable, naming another owner, or with an unknown `format_version` | Treats it as empty and decrypts every manifest |

A stale summary therefore costs reads, never a wrong answer. Readers never write the repair back, since `list` and `status` may run with read-only credentials or against a locked bucket. The next backup's summary write records the missing rows. The first backup of an owner whose summary lacks rows for older manifests decrypts them once to seed it.

Some reads still decrypt every manifest: recrawl tombstones, and the Contacts and Calendar `listSnapshots` SDK call, which returns whole manifests. Contacts and Calendar `list -m` answers from the index, and their backups read only the newest manifest.

A provider replica copies the summary with everything else. A replica that Atlas 6 wrote holds no summary, so reads against it decrypt every manifest.

### Encryption

The summary is AES-256-GCM encrypted with the tenant DEK and bound to its directory, like the manifest pointers. The body names its owner, and a reader ignores a summary that names another one, so a summary copied into another owner's directory is not used. A row is used only when its manifest key is the key its own owner and snapshot ID build. The index adds no new plaintext to the bucket: the same fields are already inside the encrypted manifests.

### When the summary is written and removed

| Event | What happens to the summary |
| --- | --- |
| Backup | Written after the manifest, its read-back, and the Outlook pointers, and before the delta cursor. It never names a manifest that failed to store |
| Backup, summary write fails | The backup still succeeds and logs a warning, because the manifest is the record |
| Backup, another writer changed it | Conditional write: `If-None-Match` creates it, `If-Match` on the ETag read replaces it. On a conflict Atlas reads, reconciles, and writes once more, then gives up with a warning. A backend that ignores conditional headers lets the later write win, which leaves a stale summary at worst |
| Backup lost its owner lease | The run checks its [owner lease](#owner-leases) right before the write, because seeding rows can take long. A run that lost it raises `OwnerLeaseLostError` and writes neither the summary nor the cursor |
| Backup with retention | Written without the run's retention, like the delta cursor, so the noncurrent-version rule expires replaced versions. See [What Object Lock covers](/operations/immutability#what-object-lock-covers) |
| `delete -s`, `quarantine` | The snapshot's row is removed under the owner's lease, after the manifest is gone and, for `delete -s`, after the delta cursor. The rewrite is a compare-and-swap on the summary just read and never creates one. If it fails, the command succeeds with a warning and readers skip the row |
| Contacts and Calendar `delete -s` | Runs without the tenant key, so it cannot rewrite the summary. It leaves the row, readers drop it, and the next backup removes it |
| Deleting an owner, mailbox, or site | The summary is removed with the owner's other `_meta` objects, and its lease last |

The summary goes through the same [guarded writer](/security#metadata-is-checked-before-and-after-it-is-stored) as the manifests, without the read-back.

## Owner leases

```text
_meta/outlook-leases/{owner_id}.json     # Outlook mail
onedrive/_meta/{owner_id}/lease.json     # also contacts/, calendar/
sharepoint/_meta/{site_id}/lease.json
teams/_meta/{team_id}/lease.json
_meta/tenant-lease.json                  # the whole tenant: purge and key re-wrap
```

Atlas runs one operation at a time per mailbox, drive owner, site, or team. A backup, deletion, or quarantine holds one lease object for its owner while it runs, so two operations never write the same owner's cursor, pointer, summary index, or checkpoint at once. A restore of a mailbox, drive owner, or site holds the same lease, so a deletion cannot remove the snapshot it is restoring. The object sits next to the owner's delta cursor. See [Concurrent operations](/reference/sdk#concurrent-operations) for the protocol.

A purge, a key re-wrap, or `atlas keys purge-old-wrappers` holds the tenant lease, `_meta/tenant-lease.json`, with the tenant ID as its owner ID. The purge of old wrappers records its operation as `rewrap`. While the tenant lease is live, owner operations of the tenant are refused. While any owner lease is live, the purge or re-wrap is refused. The tenant lease sits outside every workload's lease prefix, and the tenant-side check reads only objects whose keys are exactly an owner lease, so cursors, snapshot indexes, and other `_meta/` objects are never read as leases.

The lease is plain, unencrypted JSON, so that an operation without the tenant key, such as erasing an owner after the passphrase is lost, can still take it. Anyone with read access to the bucket can read:

| Field | What it reveals |
| --- | --- |
| `operation` | That a `backup`, `delete`, `quarantine`, or `restore` is running on the owner, or `purge` or `rewrap` on the tenant lease, or last ran if the lease was left behind |
| `acquired_at`, `expires_at` | When that operation started and when its lease runs out, which moves forward with every renewal |
| `released_at` | When it finished, present only when the lease could not be deleted |
| `holder_id` | A random ID generated for that one run. It names no host, user, or process |
| `format_version` | The lease format |

The owner ID is in the key, as it is for every object of that owner. The lease holds no backup content, no item names, and nothing derived from the tenant key.

| Property | Behavior |
| --- | --- |
| Lifetime | Written when the operation starts, read back every 60 seconds, rewritten every 5 minutes, deleted when it ends. If the delete is refused, it is rewritten as released and stays as a free lease. One left by a killed process expires 10 minutes after its last write |
| Object Lock | Never written with retention, also when the run uses `--retention-days`. A bucket default retention still locks each version, which is one more reason to remove it |
| Versions | In a versioned bucket every write leaves a noncurrent version of about 200 bytes, at most 14 per held hour. The [one-day lifecycle rule](/self-hosting/storage#lifecycle-rules) for its prefix removes them |
| Deletion | Deleting an owner removes its lease last, with all versions, so nothing is left under the erased owner's ID. A purge removes the tenant lease last, with all versions, so an erased bucket holds no lease object |
| Replicas | Copied by provider replication like any object. A restore from the replica waits out a live one, at most 10 minutes after its holder stopped |
| Storage usage | Counted like a delta cursor: under its workload for the prefixed workloads, under `meta` for Outlook. It is not backup data |

::: warning Do not delete a live lease
Do not delete a lease by hand while its operation may still be running. See [Another operation holds the owner](/troubleshooting#another-operation-holds-the-owner).
:::

## Quarantined objects

```text
_quarantine/onedrive/manifests/{owner_id}/{snapshot_id}.json
_quarantine/manifests/{owner_id}/{snapshot_id}.json
_quarantine/teams/manifests/{team_id}/{snapshot_id}.json
```

`atlas <workload> quarantine --key <key>` moves a damaged snapshot manifest or version index to `_quarantine/` followed by its original key, so the workload prefixes no longer list it. See [Damaged manifests and version indexes](/reference/cli#damaged-manifests-and-version-indexes).

- The bytes are copied unchanged. The object stays encrypted and bound to its original key, so it does not decrypt at the quarantine key.
- A second quarantine of the same key adds a millisecond suffix rather than overwriting the first copy.
- No backup, restore, listing, or verification reads `_quarantine/`.
- Deleting an owner, mailbox, site, or team removes its quarantined copies too, and `atlas delete --purge` removes the whole prefix.
- `atlas stats storage` counts the prefix as `other`, not under a workload.

## The DEK object

`_meta/dek.enc` holds the **data encryption key (DEK)**, wrapped with a key encryption key (KEK) derived from your passphrase. Without it, no message can be decrypted, no manifest can be read, and no restore is possible.

::: danger Losing dek.enc loses the whole bucket
If the file is lost or corrupted and you have no separate copy, every object in the bucket becomes permanently unreadable.
:::

Protect it:

- Restrict `DeleteObject` on `_meta/*` in the bucket policy.
- Enable Object Lock with a long retention on this key.
- Check periodically that the file exists and can be read.

With `DeleteObject` denied on `_meta/*`, Atlas cannot delete the Outlook [owner lease](#owner-leases) under `_meta/outlook-leases/` and marks it released in place instead, so the next run on that mailbox still starts at once. A bucket policy that also blocks overwrites of the key is in [Storage setup](/self-hosting/storage#protecting-the-tenant-data-key).

## How objects are named {#content-addressing}

Messages, attachments, and files are named by an HMAC-SHA256 of their **plaintext**, computed before encryption and keyed with a naming key derived from the tenant data key. Identical content within an owner gets the same name and is stored once, so a message that appears in several snapshots is one object.

Each manifest records the object's key and a plain SHA-256 checksum of the plaintext. Integrity checks decrypt the object, hash the result with SHA-256, and compare it with the manifest checksum. A match proves the content is byte-for-byte what was backed up. See [What object names reveal](/security#what-object-names-reveal).

A MIME message is one object with its attachments inside, base64-encoded. Two messages with the same attachment are two objects, so the attachment is stored once per message rather than once per mailbox, and base64 adds about one third to its size. In return, messages stay byte-exact, which matters for signed mail.

## Old versions of overwritten objects {#noncurrent-versions}

The bucket is versioned, so every overwrite or delete keeps the previous version as a noncurrent version until a [lifecycle rule](/self-hosting/storage#lifecycle-rules) expires it. Atlas never reads noncurrent versions.

| Objects | Rewritten | Noncurrent versions kept |
| --- | --- | --- |
| Owner and tenant leases | Every 5 minutes while an operation runs, at most 14 versions per held hour | 1 day |
| Delta cursors, Teams channel cursors and read checkpoints | Every run, and every 50 threads during a Teams channel read | 1 day |
| Outlook `latest.json` and `summary.json`, the `snapshots.json` summary of the other workloads | Every run | 1 day |
| `_meta/dek.enc` | On a key re-wrap | 30 days, as a recovery path after a re-wrap |
| Everything else: content, manifests, version indexes, the identity registry | Rarely; content and manifests are written once | 30 days |

The one-day window applies to every key under `_meta/outlook-leases/`, `_meta/outlook-cursors/`, `_meta/outlook-manifests/owners/`, `_meta/tenant-lease.json`, and the `_meta/` folder of each prefixed workload. Several hosted S3 providers cap the versions of one key, Scaleway and Exoscale at 1,000. Without the one-day rules a frequently backed-up owner's lease reaches that cap and its backups fail. See [Version caps of hosted providers](/self-hosting/storage#version-caps-of-hosted-providers). A version under Object Lock stays until its lock expires.

## S3 object metadata

Mailbox objects carry these headers:

| Header | Value | Encrypted |
| --- | --- | --- |
| `x-amz-meta-x-message-id` | Microsoft Graph message ID | No, visible to S3 readers |
| `Content-MD5` | MD5 of the ciphertext (transport check) | Standard S3 header |

::: warning Metadata reveals existence
Anyone with S3 read access can list Graph message IDs. The content stays encrypted, but the metadata shows which messages exist. If that exposure is not acceptable, limit the bucket to the Atlas service account and restrict the network path to the S3 endpoint.
:::

## Legacy objects

Buckets written by earlier versions can hold objects that current Atlas no longer writes:

| Object | Status |
| --- | --- |
| `attachments/{owner_id}/` | Attachments of legacy JSON message entries. Readable, restorable, and verifiable |
| `onedrive/index/{owner_id}/files/`, `sharepoint/index/{site_id}/files/` | Per-file version indexes. Readable, merged with per-run indexes, removed only by purging the owner |
| Objects named by plain SHA-256 of their plaintext | Written before keyed naming. Readable through their manifest entries |
| `x-amz-meta-x-plaintext-sha256` header | SHA-256 of the plaintext on objects written before keyed naming. Atlas neither writes nor reads it |
| `_meta/replication/`, `_meta/replica.marker` | Written by Atlas 6 replication, inert. See [Legacy Atlas 6 objects](/operations/replication#legacy-atlas-6-objects) |

## See also

- [Replicas](/operations/replication): what a copy of these objects needs for Atlas to read it
- [Immutability](/operations/immutability): Object Lock and lifecycle rules
- [Storage setup](/self-hosting/storage): creating the bucket
