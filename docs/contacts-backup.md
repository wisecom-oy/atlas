---
description: 'Back up personal Outlook contacts per mailbox incrementally, with folders and photos, and restore them without overwriting or duplicating existing contacts.'
---

# Contacts backup

Atlas backs up each user's personal Outlook contacts: every contact folder including nested folders, every contact property Microsoft 365 returns, and contact photos. Contacts are a separate workload from mail, with their own commands, SDK API, and storage prefix.

## Quick start

```bash
# Back up one mailbox, incrementally
atlas contacts backup -m user@example.com

# List snapshots, then check one
atlas contacts list -m user@example.com
atlas contacts verify -m user@example.com -s ct-snap-1735689600000-a1b2c3

# Restore a snapshot into another mailbox
atlas contacts restore -m user@example.com -s ct-snap-1735689600000-a1b2c3 -T other@example.com
```

`-m` accepts an email address or a Microsoft Entra ID object ID. `backup` prints the ID of each snapshot it creates.

## What is backed up

| Item             | Coverage                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| Contact folders  | The default Contacts folder and every folder beneath it, by display-name path           |
| Contacts         | Every property Microsoft Graph returns, stored as JSON                                  |
| Contact photos   | Stored as separate objects. Identical photos are stored once per mailbox                |

Exchange stores a contact photo as an attachment, so a backup downloads photos only for contacts that carry one. A single listing per changed folder, filtered on the server by the store-computed `PidTagHasAttachments` property, finds those contacts. A folder whose contacts have no photos costs one request rather than one per contact.

Each snapshot is complete on its own: it lists every folder and contact that existed at that run, so a restore or verify reads one snapshot and never needs an older one. A contact, or a photo, is stored once however many snapshots include it. Each level of the folder listing is checked against the count Microsoft Graph reports for it, so a listing that ends early stops the run with exit `2` before anything is written, rather than dropping the unlisted folders from the snapshot. See [Unit listings that end early](/operations/reliability#unit-listings).

Every contact and photo is encrypted under the tenant data key before upload and named by a keyed HMAC-SHA256, the same naming mail and drive objects use, so object names reveal nothing about the content. See [What object names reveal](/security#what-object-names-reveal).

Not backed up:

- **Contact groups** (Outlook contact lists). The Microsoft Graph contacts API does not expose them.
- **Photo-only changes, until the contact changes.** Microsoft Graph may not report a new photo on an otherwise unchanged contact, so the new photo can wait until the contact itself changes.

## Permissions and licensing

| Operation            | Microsoft Graph application permission         |
| -------------------- | ---------------------------------------------- |
| Backup               | `Contacts.Read`                                |
| Restore              | `Contacts.ReadWrite`                           |
| List, verify, delete | None: these read and write backup storage only |

Passing a mailbox as an email address looks it up to an Entra object ID first, which needs `User.Read.All`. Passing the object ID skips that lookup. Mail-only app registrations have neither contacts permission, so add them before the first contacts run. See [Azure AD setup](/azure-ad-setup).

The mailbox must hold an Exchange Online license. Microsoft Graph does not serve contacts for an unlicensed mailbox.

| Problem              | Error                                                          | Exit |
| -------------------- | -------------------------------------------------------------- | ---- |
| Missing permission   | `ATLAS_AUTH_DENIED`, naming the permission to add              | `4`  |
| Unlicensed mailbox   | `MailboxNotLicensedError` (`ATLAS_MAILBOX_NOT_LICENSED`)       | `4`  |

Both end a backup or restore at once, because no further request can succeed.

## Commands

Every command accepts `-t, --tenant <id>` to override the tenant from config. The full option list is in the [CLI reference](/reference/cli#atlas-contacts).

### backup

| Flag                          | Description                                                     | Default        |
| ----------------------------- | --------------------------------------------------------------- | -------------- |
| `-m, --mailbox <email or id>` | Mailbox                                                         | Required       |
| `--full`                      | Ignore the saved sync checkpoints and read every contact again  | `false`        |
| `--retention-days <n>`        | Lock this run's backup data for `n` days with Object Lock       | Off            |
| `--lock-mode <mode>`          | `governance` or `compliance`; requires `--retention-days`       | `governance`   |
| `-t, --tenant <id>`           | Tenant identifier                                               | Config default |

```bash
atlas contacts backup -m user@example.com
atlas contacts backup -m user@example.com --full
```

Atlas reads the default Contacts folder (`/contactFolders/contacts`) and walks its `childFolders`. Each folder keeps its own sync checkpoint (a Microsoft Graph delta link), stored encrypted at `contacts/_meta/{mailbox}/delta.json`, so later runs read only the contacts that changed. Requests carry `Prefer: IdType="ImmutableId"`, so contact IDs stay stable when a contact moves between folders. A run with no changes creates no snapshot.

Contacts traffic counts against the Outlook throttling pool. Atlas stores four contacts of a folder at a time, matching the Exchange limit of four concurrent requests per mailbox. See [Graph rate limits](/operations/graph-rate-limits).

### restore

Restores a snapshot into the source mailbox, or with `-T` into another mailbox. Restore only adds: it never overwrites or deletes a contact.

| Flag                          | Description                                                     | Default        |
| ----------------------------- | --------------------------------------------------------------- | -------------- |
| `-m, --mailbox <email or id>` | Source mailbox                                                  | Required       |
| `-s, --snapshot <id>`         | Snapshot to restore                                             | Required       |
| `-T, --target <email or id>`  | Mailbox to restore into                                         | Source mailbox |
| `--target-profile <name>`     | Tenant profile whose credentials perform a cross-tenant restore. Requires `-T` | None |
| `-t, --tenant <id>`           | Tenant identifier                                               | Config default |

```bash
atlas contacts restore -m user@example.com -s ct-snap-1735689600000-a1b2c3
atlas contacts restore -m user@example.com -s ct-snap-123 --target other@example.com
```

How restore places contacts:

- **Folders.** A source folder maps onto the target folder at the same display-name path. A missing folder is created, parent first. Names are compared without case, as Exchange does, so a target folder `team` receives the contacts of a source folder `Team`. Exchange rejects sibling folders whose names differ only in case, so a path always names one folder.
- **Source tag.** Each restored contact carries a single-value extended property, `AtlasSourceContactId`, holding the ID of the contact it was restored from.
- **Duplicates.** An entry is skipped and counted in `contacts_skipped` when the target folder already holds the original contact under the ID the backup recorded, or a contact tagged with that ID by this or an earlier restore. Two different people who share a display name are both restored. Restoring a snapshot twice creates nothing the second time, including contacts with no name or email.
- **Contacts Atlas did not create.** A contact with no tag that is not in the snapshot, such as the same person entered by hand or imported by another tool, matches an entry with the same display name, email addresses, phone numbers, and company (trimmed, lowercased, sorted). A contact with none of these fields never matches by content.

Anyone who can read the target mailbox can see the source tag, including the target mailbox owner in a restore with `-T`. Removing or changing it only makes the next restore create that contact again. See [Security](/security).

Every object is checked against its recorded SHA-256 before it is written to the mailbox.

### list

Lists the snapshots stored for a mailbox, newest first.

```bash
atlas contacts list -m user@example.com
```

### verify

Checks every object a snapshot references. A full check decrypts each object and compares it with its recorded SHA-256. `--fast` checks only that each object exists, without downloading or decrypting, which catches missing objects cheaply.

| Flag                          | Description           | Default        |
| ----------------------------- | --------------------- | -------------- |
| `-m, --mailbox <email or id>` | Mailbox               | Required       |
| `-s, --snapshot <id>`         | Snapshot to verify    | Required       |
| `--fast`                      | Existence-only checks | `false`        |
| `-t, --tenant <id>`           | Tenant identifier     | Config default |

```bash
atlas contacts verify -m user@example.com -s ct-snap-123
atlas contacts verify -m user@example.com -s ct-snap-123 --fast
```

A full check lists each damaged object: one the bucket reports as absent, ciphertext that fails authentication, or a checksum mismatch. It exits `1` when a check fails and `2` when interrupted. Any other storage error stops the run.

### delete

| Flag                          | Description                                     | Default        |
| ----------------------------- | ----------------------------------------------- | -------------- |
| `-m, --mailbox <email or id>` | Mailbox                                         | Required       |
| `-s, --snapshot <id>`         | Delete one snapshot instead of every backup     | All data       |
| `-y, --yes`                   | Skip the confirmation prompt                    | `false`        |
| `-t, --tenant <id>`           | Tenant identifier                               | Config default |

```bash
atlas contacts delete -m user@example.com
atlas contacts delete -m user@example.com -s ct-snap-123
```

Without `-s`, every contacts backup for the mailbox is removed. With `-s`, Atlas removes that snapshot's manifest and the mailbox's sync checkpoints, and keeps the contact and photo objects other snapshots share. Each snapshot is complete, so deleting any one leaves the others whole. The next backup reads every folder in full and captures again what the deleted snapshot held. `atlas delete --purge` removes contacts together with the rest of the tenant bucket.

::: danger Irreversible
Deletion cannot be undone. Objects under Object Lock retention stay until the retention period ends. See [Erasure](/security#erasure).
:::

### quarantine

Moves an unreadable snapshot manifest to `_quarantine/` so later runs stop reporting it.

```bash
atlas contacts quarantine --key contacts/manifests/<mailbox-id>/<snapshot-id>.json
```

| Flag                  | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `--key <storage-key>` | Storage key a command reported as unreadable (required) |
| `-t, --tenant <id>`   | Tenant identifier                                       |

Only the quarantined snapshot is lost, because every other snapshot is complete. Quarantine also removes the mailbox's sync checkpoints, so the next backup reads the mailbox in full. See [Damaged manifests](/reference/cli#damaged-manifests-and-version-indexes).

## Reading the result

A backup prints `Snapshot <id> created` with `changed`, `stored`, and, when above zero, `removed` counts, then `Status: HEALTHY` or `Status: UNHEALTHY`. When no snapshot is written it prints one of:

| Output                                                                | Meaning                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `No contact changes detected. Snapshot skipped.`                      | Nothing changed since the last run. An earlier snapshot covers it |
| `No contacts found. Nothing was backed up and no snapshot exists.`    | The mailbox holds no contacts                                  |
| `No snapshot created: the run was interrupted or every change failed.` | Check the errors above it                                      |

A restore prints `Contacts restored`, `Contacts skipped (already present)`, and `Folders created`.

| Exit | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | Complete                                                                      |
| `2`  | Partial: a contact failed, or the run was interrupted                         |
| `4`  | Missing permission or unlicensed mailbox                                      |
| `9`  | A damaged snapshot manifest was found. Run the printed `atlas contacts quarantine` command |

See [Exit codes](/reference/cli#exit-codes) for the full list.

## When a contact cannot be backed up or restored

| Situation                                      | What Atlas does                                                                                                 | What you do                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| A contact fails to store                       | Keeps its entry from the previous snapshot, names it in the errors, stores the rest of the folder. Exits `2`     | Nothing. The next run fetches it again          |
| Microsoft Graph rejects a saved sync checkpoint | Reads that folder from the start                                                                                | Nothing                                         |
| The run is interrupted (Ctrl+C, crash)          | Saves no snapshot and no sync checkpoint. Objects already uploaded stay in storage, under Object Lock if requested, and the next run reuses them | Run the backup again                            |
| A newer snapshot manifest cannot be read        | Reads every folder in full, writes a fresh snapshot, names the key, exits `9`                                    | Quarantine the key                              |
| A stored object fails its SHA-256 on restore    | Reports an error naming the contact, continues. Exits `2`                                                        | Run `verify` on the snapshot                    |
| A photo upload fails on restore                 | Counts the contact as restored and reports the photo failure separately                                          | Check the reported contact                      |
| Missing permission or unlicensed mailbox        | Ends the backup or restore. Exits `4`                                                                            | Fix consent or licensing                        |

The failed contact's folder keeps its old sync checkpoint, or none if Microsoft Graph rejected the old one, which is why the next run delivers that contact again.

## Limits

- Contact groups are not backed up.
- A photo-only change can wait until the contact changes.
- Restore never overwrites or deletes a contact, so it cannot roll a contact back to an earlier version in place.
- Throttling follows the Outlook pool, four concurrent requests per mailbox.

## SDK usage

The SDK exposes the same operations on `atlas.contacts`. Options and results use camelCase, and mailbox arguments accept an email address or an object ID.

```ts
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: '<tenant-id>',
  clientId: '<client-id>',
  clientSecret: '<client-secret>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<access-key>',
  s3SecretKey: '<secret-key>',
  encryptionPassphrase: '<passphrase>',
});

const run = await atlas.contacts.backup('user@example.com');
if (!run.summary.healthy) {
  console.error(run.summary.errors);
}

if (run.snapshot) {
  const restored = await atlas.contacts.restore('user@example.com', {
    snapshotId: run.snapshot.snapshotId,
    targetMailboxId: 'other@example.com',
  });
  console.log(`Restored ${restored.contactsRestored}, skipped ${restored.contactsSkipped}`);
}
```

| Result             | Fields                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `backup().summary` | `foldersScanned`, `contactsChanged`, `contactsRemoved`, `objectsStored`, `snapshotCreated`, `noSnapshotReason`, `errors`, `healthy`, `unreadableKeys` |
| `restore()`        | `snapshotId`, `contactsRestored`, `contactsSkipped`, `foldersCreated`, `errors`, `interrupted`                                |

Other methods: `verify`, `listSnapshots`, `listSnapshotSummaries`, `deleteMailboxData`, `deleteSnapshot`, and `quarantine`. See the [SDK reference](/reference/sdk).

## See also

- [CLI reference: `atlas contacts`](/reference/cli#atlas-contacts)
- [SDK reference](/reference/sdk)
- [Storage layout](/operations/storage-layout)
- [Calendar backup](/calendar-backup)
- [Security model](/security)
