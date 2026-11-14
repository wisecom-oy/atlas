---
description: Combine Atlas verify, restore, save, delete, replicate, and rehydrate in the right order for infrequent, high-stakes recovery and management work.
---

# Recovery and management workflows

The recovery commands (`verify`, `restore`, `save`, `delete`, `replicate`, and `rehydrate`) are documented flag by flag in [CLI commands](/reference/cli). This page covers how to combine them. These operations are infrequent and high stakes, so the order matters.

## Verify before you restore

Run [`atlas outlook verify`](/reference/cli#atlas-outlook-verify) on a snapshot before you rely on it. Verification walks the snapshot's merged manifest chain, decrypts and re-hashes every referenced object (message bodies and attachments), and compares each against its manifest checksum. A corrupt object from an older backup fails every later snapshot that references it, so verify the snapshot you plan to restore, not only the latest one.

For a compliance export or legal hold, use [`atlas outlook save`](/reference/cli#atlas-outlook-save) instead of restore. It writes standard `.eml` files into a zip archive without touching the Microsoft 365 mailbox, and it SHA-256 verifies every message after decryption.

[`atlas outlook restore`](/reference/cli#atlas-outlook-restore) has two modes. Snapshot mode restores one snapshot. Mailbox mode combines every snapshot for a mailbox, deduplicates them, and restores the result. Passing both `--snapshot` and `--mailbox` is refused. To choose a different destination mailbox, pass `--target`, so a cross-mailbox restore is always a deliberate choice.

By default each restore writes into a new `Restore-<timestamp>` folder at the top of the mailbox, so deleting that one folder undoes it. To put the mail where the user expects it, pass `--destination`:

```bash
atlas outlook restore -s <snapshot-id> -T john.doe@example.com --destination "Recovered/2026-03 incident"
```

Existing folders on that path are reused, so a second restore into the same destination does not fail. It does create every message again, because restore does not deduplicate against the target. Rerun into a fresh destination, or delete the earlier copy first. A destination inside Inbox, Sent Items, or another well-known folder is refused, so restored mail never mixes into live mail.

## Deleting data safely

[`atlas outlook delete`](/reference/cli#atlas-outlook-delete) removes manifests first, then data objects. If a delete is interrupted, you are left with harmless orphan blobs rather than manifests that point at missing data. Plan around three consequences:

- Deleting one snapshot removes only its manifest. The data objects stay, because other snapshots may reference them.
- `atlas delete --purge` deletes everything in the tenant bucket, including the encrypted data key at `_meta/dek.enc`. All data for the tenant becomes permanently inaccessible across Outlook, OneDrive, and SharePoint.
- When Object Lock retention protects objects, delete exits non-zero and reports retained items separately from real failures. Retained items become deletable when retention expires.

## Replication and disaster recovery

Run [`atlas replicate`](/reference/cli#atlas-replicate) on a schedule against a secondary S3 target. Ciphertext is copied as-is, so the replica never sees plaintext. Each transfer covers only unreplicated snapshots and missing objects. See [Replication](/operations/replication) for target layout and scheduling.

[`atlas rehydrate`](/reference/cli#atlas-rehydrate) is the reverse path for disaster recovery, from replica to primary. It is not a bidirectional sync. It copies the snapshots you select, skips anything already on primary, and does not merge or resolve conflicts. Check two things before you run it:

- Rehydration needs the replica's encryption key on primary. Atlas copies the key automatically into an empty bucket, or into a freshly initialized bucket whose only object is that key. Otherwise it aborts with `DekOverwriteRefusedError` rather than overwrite a key that protects existing data. If primary's content is disposable, run `atlas delete --purge` first, then rehydrate into the empty bucket. A different key that another run stores while rehydration is checking the bucket stops it with `DekWriteConflictError` instead of being overwritten. Run rehydration alone.
- Delta links in recovered manifests can be stale. Atlas falls back to a full sync on the next backup automatically, so that first backup takes longer.

## Cross-tenant restore

Use `--target-profile` to restore into a second Microsoft 365 tenant. The backup stays in the source tenant's bucket. The writes use the destination tenant's app registration, so both tenants need a profile:

```bash
pbpaste | atlas tenants add contoso --tenant-id <tenant-id> --client-id <client-id> --client-secret -
pbpaste | atlas tenants add fabrikam --tenant-id <tenant-id> --client-id <client-id> --client-secret -
atlas tenants validate --all

atlas --profile contoso outlook restore -s <snapshot-id> --target-profile fabrikam -T john.doe@example.com
atlas --profile contoso onedrive restore -o john.doe@example.com -s <snapshot-id> --target-owner jane.doe@example.com --target-profile fabrikam
```

The source profile supplies the storage tenant, S3 credentials, and passphrase. Each restore command needs its explicit target flag, because object IDs differ between tenants:

| Command                    | Explicit target flag           |
| -------------------------- | ------------------------------ |
| `atlas outlook restore`    | `-T, --target <email>`         |
| `atlas contacts restore`   | `-T, --target <email or id>`   |
| `atlas calendar restore`   | `-T, --target <email or id>`   |
| `atlas onedrive restore`   | `--target-owner <email or id>` |
| `atlas sharepoint restore` | `--target-site <url-or-id>`    |

Before you run a cross-tenant restore:

- The destination owner exists in the destination tenant and holds the license for that workload.
- The destination app registration has write permissions there: `Mail.ReadWrite` (Outlook), `Contacts.ReadWrite` (contacts), `Calendars.ReadWrite` (calendar), `Files.ReadWrite.All` (OneDrive), or `Sites.ReadWrite.All` (SharePoint).
- `ATLAS_*` environment variables do not apply to the target profile. Set its credentials only in the profile.
- An Outlook restore names folders from what the snapshots recorded and sends Graph requests only for the target mailbox. Snapshots written before Atlas 5.2.3 record no folders. For those the restore has to list the source mailbox through the destination tenant's app, which cannot see it, so the run exits `7` before it writes a message. See [atlas outlook restore](/reference/cli#atlas-outlook-restore).

`--target-profile` applies to `outlook`, `contacts`, `calendar`, `onedrive`, and `sharepoint` restores. `restore-version` does not accept it and writes into the source tenant. See [Tenant profiles](/configuration#tenant-profiles) and [Security](/security#tenant-profiles-and-cross-tenant-restore).

## See also

- [CLI commands](/reference/cli): full flag reference for every command
- [OneDrive backup](/onedrive-backup): OneDrive restore, save, and verify
- [SharePoint backup](/sharepoint-backup): SharePoint restore, save, and verify
- [Replication](/operations/replication): the replication and rehydration process in operational detail
- [Migrating to v7](/migration/v7): moving credentials into tenant profiles
