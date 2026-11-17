---
description: The order in which to run Atlas verify, restore, save, and delete for infrequent, high-stakes recovery and management work.
---

# Recovery and management workflows

Recovery and deletion are rare and hard to undo, so the order of commands matters. This page shows that order. Every flag is documented in [CLI commands](/reference/cli).

## Verify before you restore

```bash
atlas outlook verify -m user@example.com -s <snapshot-id>
atlas outlook restore -s <snapshot-id> -T john.doe@example.com --destination "Recovered/2026-03 incident"
```

1. **Verify the snapshot you plan to restore**, not only the latest one. [`atlas outlook verify`](/reference/cli#atlas-outlook-verify) reads the snapshot together with every older snapshot it builds on, decrypts every message body and attachment, and checks each against its recorded SHA-256 checksum. A corrupt object from an older backup fails every later snapshot that references it.
2. **Choose restore or save.** For a compliance export or legal hold, use [`atlas outlook save`](/reference/cli#atlas-outlook-save). It writes standard `.eml` files into a zip archive without touching the Microsoft 365 mailbox, and verifies every message's SHA-256 checksum after decryption.
3. **Pick the scope.** [`atlas outlook restore`](/reference/cli#atlas-outlook-restore) restores one snapshot with `--snapshot`, or combines and deduplicates every snapshot of a mailbox with `--mailbox`. Passing both is refused. A different destination mailbox needs `--target`, so a cross-mailbox restore is always a deliberate choice.
4. **Pick the destination.** By default each restore writes into a new `Restore-<timestamp>` folder at the top of the mailbox, so deleting that one folder undoes it. `--destination` puts the mail where the user expects it.

::: warning A second restore into the same destination duplicates mail
Existing folders on the `--destination` path are reused, so a second restore into it does not fail, but it creates every message again: restore does not compare against what the target holds. Rerun into a fresh destination, or delete the earlier copy first. A destination inside Inbox, Sent Items, or another well-known folder is refused, so restored mail never mixes into live mail.
:::

## Deleting data safely

```bash
atlas outlook delete -s <snapshot-id>           # newest snapshot only, data kept
atlas outlook delete -m user@example.com        # one mailbox, everything
atlas delete --purge                            # the whole tenant, irreversible
```

[`atlas outlook delete`](/reference/cli#atlas-outlook-delete) removes manifests first, then data objects, so an interrupted delete leaves harmless orphan objects rather than manifests that point at missing data.

| Command                    | What it removes                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `delete -s <snapshot-id>`  | Only that snapshot's manifest. The data objects stay, because other snapshots may reference them        |
| `delete -m`, `-o`, `--site`, `--team` | Every backup of that mailbox, owner, site, or team                                           |
| `atlas delete --purge`     | Everything in the tenant bucket, across every workload, including the encrypted data key at `_meta/dek.enc` |

::: danger A purge makes all tenant data permanently inaccessible
`atlas delete --purge` cannot be undone. It deletes the tenant's encrypted data key along with the data, and all data for the tenant becomes permanently inaccessible across every workload.
:::

When Object Lock retention protects objects, a delete exits non-zero and reports retained items separately from real failures. Retained items become deletable when retention expires.

## Disaster recovery from a replica

```bash
ATLAS_S3_ENDPOINT=https://replica.example.com atlas outlook verify -m user@example.com -s <snapshot-id>
ATLAS_S3_ENDPOINT=https://replica.example.com atlas outlook restore -s <snapshot-id>
```

Atlas keeps no copy of its own. Your storage provider replicates the bucket, or `rclone copy` or `mc mirror` copies it on a schedule (see [Replica setup](/self-hosting/replication)). To recover, point the S3 settings at the replica, with its own keys in `ATLAS_S3_ACCESS_KEY` and `ATLAS_S3_SECRET_KEY`, and run the same commands you run against the primary.

Use read-only credentials for the replica, and verify it before you depend on it. [Replicas](/operations/replication) covers consistency, leases, and what the replica bucket must contain.

## Cross-tenant restore

```bash
pbpaste | atlas tenants add contoso --tenant-id <tenant-id> --client-id <client-id> --client-secret -
pbpaste | atlas tenants add fabrikam --tenant-id <tenant-id> --client-id <client-id> --client-secret -
atlas tenants validate --all

atlas --profile contoso outlook restore -s <snapshot-id> --target-profile fabrikam -T john.doe@example.com
atlas --profile contoso onedrive restore -o john.doe@example.com -s <snapshot-id> --target-owner jane.doe@example.com --target-profile fabrikam
```

`--target-profile` restores into a second Microsoft 365 tenant. The backup stays in the source tenant's bucket. The source profile (`--profile`) supplies the storage tenant, S3 credentials, and passphrase. The target profile's app registration performs the writes, so both tenants need a profile.

Object IDs differ between tenants, so each restore command needs its explicit target flag:

| Command                    | Explicit target flag           |
| -------------------------- | ------------------------------ |
| `atlas outlook restore`    | `-T, --target <email>`         |
| `atlas contacts restore`   | `-T, --target <email or id>`   |
| `atlas calendar restore`   | `-T, --target <email or id>`   |
| `atlas onedrive restore`   | `--target-owner <email or id>` |
| `atlas sharepoint restore` | `--target-site <url-or-id>`    |

Before you run a cross-tenant restore, check:

- The destination owner exists in the destination tenant and holds the license for that workload.
- The destination app registration has write permissions there: `Mail.ReadWrite` (Outlook), `Contacts.ReadWrite` (contacts), `Calendars.ReadWrite` (calendar), `Files.ReadWrite.All` (OneDrive), or `Sites.ReadWrite.All` (SharePoint).
- The target profile's credentials are set in the profile itself. `ATLAS_*` environment variables do not apply to it.
- For Outlook, the snapshots were taken with Atlas 5.2.3 or later. Those record their folders, so the restore sends requests only to the target mailbox. Older snapshots record no folders, and the restore would have to list the source mailbox through the destination tenant's app, which cannot see it, so the run exits `7` before it writes a message. See [atlas outlook restore](/reference/cli#atlas-outlook-restore).

`--target-profile` applies to `outlook`, `contacts`, `calendar`, `onedrive`, and `sharepoint` restores. `restore-version` does not accept it and writes into the source tenant. See [Tenant profiles](/configuration#tenant-profiles) and [Security](/security#tenant-profiles-and-cross-tenant-restore).

## See also

- [CLI commands](/reference/cli): full flag reference for every command
- [OneDrive backup](/onedrive-backup): OneDrive restore, save, and verify
- [SharePoint backup](/sharepoint-backup): SharePoint restore, save, and verify
- [Replicas](/operations/replication): restoring from and verifying a replica
- [Migrating to v7](/migration/v7): moving credentials into tenant profiles
