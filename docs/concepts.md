---
description: 'The Atlas terms behind CLI output and error messages: packages, workloads, snapshots, encryption keys, and incremental backups, in plain language.'
---

# Concepts

This page explains the ideas behind Atlas and the terms you will meet in CLI output, error messages, and the rest of the documentation.

## Packages: CLI and SDK

Atlas ships as two npm packages built on the same engine:

|               | `@wisecom/atlas-cli`                                  | `@wisecom/atlas-sdk`                                |
| ------------- | ----------------------------------------------------- | --------------------------------------------------- |
| **Install**   | `npm install -g @wisecom/atlas-cli`                   | `npm add @wisecom/atlas-sdk`                        |
| **Interface** | Shell commands such as `atlas outlook backup`         | Typed methods such as `atlas.outlook.backup()`      |
| **Config**    | `.env` file, environment variables, or `atlas config` | Object passed to `createAtlasInstance()`            |
| **Best for**  | Cron jobs, systemd timers, operator workflows         | Custom applications, multi-tenant services, portals |

Both cover every workload. The CLI suits scheduled jobs and operators. The SDK suits applications that call Atlas from code.

## Workloads

Atlas backs up six Microsoft 365 workloads. Each has its own CLI namespace and its own area in the tenant's bucket:

| Workload       | CLI namespace      | What you back up                                | Where it is stored in the bucket                |
| -------------- | ------------------ | ----------------------------------------------- | ----------------------------------------------- |
| **Outlook**    | `atlas outlook`    | A mailbox (email address or Entra object ID)    | Bucket root: `data/`, `attachments/`, `manifests/` |
| **Contacts**   | `atlas contacts`   | A mailbox's personal contacts                   | `contacts/`                                     |
| **Calendar**   | `atlas calendar`   | A mailbox's calendars                           | `calendar/`                                     |
| **OneDrive**   | `atlas onedrive`   | A user's drive (email, UPN, or Entra object ID) | `onedrive/`                                     |
| **SharePoint** | `atlas sharepoint` | A site (URL or Microsoft Graph site ID)         | `sharepoint/`                                   |
| **Teams**      | `atlas teams`      | A team (Microsoft Graph team ID)                | `teams/`                                        |

All workloads in a tenant share one bucket and one data key. Commands that work across workloads, such as `atlas stats` and `atlas delete --purge`, act on the whole tenant. [Storage layout](./operations/storage-layout.md) shows every path.

## Snapshots

A **snapshot** is a point-in-time record of what Atlas backed up. It is not a full copy of the data. Each snapshot is a **manifest**, a JSON file in the bucket that lists items with their metadata: IDs, paths or folder names, SHA-256 checksums, and the object paths that hold the encrypted content.

The content itself is stored separately and shared between snapshots. A message that is still in the mailbox next week points to the same stored object as today's snapshot, so it is stored once.

- Snapshots are written once and never modified.
- Outlook, OneDrive, and SharePoint snapshots record only the changes of their own run and build on the snapshots before them. Only the newest snapshot can be deleted on its own; deleting an older one is refused with `ATLAS_SNAPSHOT_NOT_NEWEST` (exit `11`). Contacts and Calendar snapshots are complete on their own.
- With Object Lock enabled on the bucket, retention protects manifests from deletion for the configured period. See [Immutability](./operations/immutability.md).
- A run that finds no changes writes no new snapshot, so the latest snapshot stays current.
- An Outlook snapshot also records the messages its run saw deleted, so a restore from it does not bring them back. A run that skipped a folder mail could have moved into, such as Junk Email with `--exclude-junk`, records none.

`backup` prints the ID of each snapshot it creates, and `list` or `list-snapshots` shows earlier ones. Commands that read a snapshot, such as `atlas outlook list -s <snapshot-id>`, `atlas outlook restore -s <snapshot-id>`, and the other workloads' `restore`, `save`, and `verify` commands, use its manifest to find and decrypt the objects they need.

### Snapshot IDs

| Workload   | Format                               | Example                                  |
| ---------- | ------------------------------------ | ---------------------------------------- |
| Outlook    | A UUID                               | `3f2b8c1e-7a4d-4e9b-9c2a-5d6e7f8a9b0c`   |
| Contacts   | `ct-snap-<milliseconds>-<6-hex>`     | `ct-snap-1735689600000-a1b2c3`           |
| Calendar   | `cal-snap-<milliseconds>-<6-hex>`    | `cal-snap-1735689600000-a1b2c3`          |
| OneDrive   | `od-snap-<milliseconds>-<6-hex>`     | `od-snap-1735689600000-a1b2c3`           |
| SharePoint | `sp-snap-<milliseconds>-<6-hex>`     | `sp-snap-1735689600000-a1b2c3`           |
| Teams      | `teams-snap-<milliseconds>-<6-hex>`  | `teams-snap-1735689600000-a1b2c3`        |

`<milliseconds>` is the snapshot's creation time as Unix epoch milliseconds.

## Each item is stored once

Atlas names every stored message, attachment, and file after its content, so identical content is written only once.

- **Same message in several snapshots of one mailbox**: an unchanged item adds a manifest entry, not a second copy.
- **Same file across OneDrive versions**: uploading identical content again writes no new object.
- **Same content in two mailboxes, drives, sites, or teams**: stored once per owner. Deduplication never crosses owners, and tenants never share objects.

The name is an HMAC-SHA256 of the plaintext, keyed with a naming key derived from the tenant's data key and prefixed by the owner's ID, for example `data/<owner-id>/<content-name>` for Outlook messages and `attachments/<owner-id>/<content-name>` for their attachments. Because the name depends on your key, someone with access to the bucket cannot test whether a known file is stored there.

Deleting a snapshot removes only its manifest, because other snapshots may still reference the same objects. Deleting a whole mailbox, drive owner, site, or team removes its content objects as well. See the workload guides and the [CLI reference](./reference/cli.md) for the delete commands.

## Encryption keys

Atlas uses two keys, where one locks the other. [Security](./security.md) describes the full model.

| Key | Technical name | What it is |
| --- | --- | --- |
| **Data key** | DEK (data encryption key) | A 256-bit AES key generated once per tenant. It encrypts all content in the bucket. It is stored only in wrapped (encrypted) form at `_meta/dek.enc`, a self-describing blob whose header records the key derivation parameters. |
| **Passphrase key** | KEK (key encryption key) | Derived from your passphrase with scrypt (N=65536, r=8, p=1), a random salt for each wrap, and the tenant ID as a domain separator. It wraps the data key with AES-256-GCM. It is never stored: Atlas derives it again from the passphrase whenever it needs it. |

A copy of the bucket therefore holds ciphertext and key derivation parameters, but no usable key. The passphrase is the only way back in.

::: danger Passphrase loss means data loss
Without the passphrase, the data key cannot be unwrapped and the backups cannot be read. Atlas has no recovery key.
:::

## Incremental backups

After the first full backup, Atlas asks Microsoft 365 only for what changed since the previous run. It keeps a **sync checkpoint** (a Microsoft Graph delta link) that marks where the last run stopped in the change history:

| Workload   | One checkpoint per |
| ---------- | ------------------ |
| Outlook    | Mail folder        |
| Contacts   | Contact folder     |
| Calendar   | Calendar           |
| OneDrive   | Drive              |
| SharePoint | Document library   |
| Teams      | Channel            |

When a checkpoint cannot be used, Atlas reads that folder, drive, or channel in full. `--full` forces a full backup. See [Delta sync](./operations/delta-sync.md) for when this happens.

## Glossary

Each plain term used in these docs, and the technical term you will see in output, flags, and error messages.

| Term in these docs | You will also see | Meaning |
| --- | --- | --- |
| **Tenant** | tenant ID | A Microsoft 365 organization, identified by its Microsoft Entra tenant ID (a GUID). Each tenant has its own bucket, its own data key, and its own backups across all workloads. |
| **Tenant profile** | `--profile`, `atlas tenants` | One stored app registration for a tenant. See [Configuration](./configuration.md#tenant-profiles). |
| **Owner** | owner ID, `-o`, `-m` | The mailbox, OneDrive user, site, or team a backup belongs to. Users and mailboxes are stored under their Entra object ID. The CLI accepts an email address or UPN and looks up the object ID. |
| **Site** | site ID, `--site` | A SharePoint site, identified by URL or Microsoft Graph site ID. Storage uses the site and web GUIDs without the hostname, so renaming the SharePoint domain does not start a new history. |
| **Snapshot** | manifest, `-s <snapshot-id>` | A point-in-time backup record: a manifest plus the objects it references. |
| **Full backup** | full sync, full crawl, `--full` | A run that reads everything, ignoring the saved sync checkpoint. |
| **Incremental backup** | delta sync, delta query | A run that reads only changes since the last sync checkpoint. |
| **Sync checkpoint** | delta link, delta cursor, delta state | The saved position in Microsoft 365's change history that the next incremental backup starts from. |
| **Data key** | DEK, `dek.enc` | The per-tenant key that encrypts content. |
| **Passphrase key** | KEK | The key derived from your passphrase that wraps the data key. |
| **Object path** | storage key, `--key` | The path of one object in the bucket. See [Storage layout](./operations/storage-layout.md). |
| **List of failed files** | failed-item ledger, failed items | Files that could not be backed up, retried on later runs and reported until they succeed or are permanently skipped. |
| **One operation at a time** | lease, `ATLAS_OWNER_BUSY`, `lease_expires_at` | Atlas runs one operation at a time per mailbox, drive owner, site, or team. A second one is refused and writes nothing. |
| **Replica** | replica endpoint | A second copy of the tenant bucket, kept by the storage provider or a copy tool in another location. Atlas restores from and verifies it when pointed at its endpoint. See [Replicas](/operations/replication). |

## See also

- [Getting started](./getting-started.md): install and run a first backup
- [OneDrive backup](./onedrive-backup.md), [SharePoint backup](./sharepoint-backup.md), [Teams backup](./teams-backup.md), [Contacts backup](./contacts-backup.md), [Calendar backup](./calendar-backup.md)
- [Storage layout](./operations/storage-layout.md): every object path for each workload
- [Delta sync](./operations/delta-sync.md): how incremental backups work
