# Contacts backup

Atlas backs up each user's personal Outlook contacts: every contact folder including nested folders, every contact property Graph returns, and contact photos. Contacts are a separate workload from mail, with their own commands, SDK API, and storage prefix.

```bash
atlas contacts backup -m user@company.com
atlas contacts list -m user@company.com
atlas contacts verify -m user@company.com -s ct-snap-1735689600000-a1b2c3
atlas contacts restore -m user@company.com -s ct-snap-1735689600000-a1b2c3 -T other@company.com
atlas contacts delete -m user@company.com -s ct-snap-1735689600000-a1b2c3
```

Every option is listed in the [CLI reference](/reference/cli#atlas-contacts).

## Permissions

| Operation            | Application permission |
| -------------------- | ---------------------- |
| Backup, list, verify | `Contacts.Read`        |
| Restore              | `Contacts.ReadWrite`   |

A missing grant fails with `ATLAS_AUTH_DENIED` and names the permission to add. Mail-only app registrations do not have either, so add them before the first contacts run. See [Azure AD setup](/azure-ad-setup).

## How a backup runs

1. Atlas reads the default Contacts folder (`/contactFolders/contacts`) and walks its `childFolders` recursively.
2. Each folder gets its own Graph delta query, sent with `Prefer: IdType="ImmutableId"` so contact IDs survive moves. The delta links are stored encrypted at `contacts/_meta/{mailbox}/delta.json`.
3. Each changed contact is serialised to JSON and its photo is fetched. Both are encrypted under the tenant DEK and stored under a keyed content name (HMAC-SHA256 under a key derived from the DEK), the same naming mail and drive objects use. An object that already exists is not uploaded again.
4. Atlas writes a manifest that lists every folder and contact. Each manifest is complete on its own, so restore and verify read one manifest and never fold a chain.

A contact that fails to store keeps its entry from the previous snapshot, and its folder keeps the old delta link, so the next run picks the change up again. A run with no changes creates no snapshot. An interrupted run writes nothing. Contacts traffic counts against the Outlook Graph throttling pool, per mailbox.

## Restore

Restore recreates missing folders by their display-name path, then creates each contact and its photo. It never overwrites. A contact whose display name and email addresses (trimmed, lowercased, sorted) match a contact already in the target folder is skipped and counted as skipped. Restoring a snapshot twice therefore creates nothing the second time, and a different person who shares an email address is left alone.

Every object is checked against its recorded SHA-256 before it is written. A mismatch is reported as an error for that contact and the restore continues. A partial restore exits `2`.

## Deletion

`atlas contacts delete -m` removes all contacts data for a mailbox. Adding `-s` removes one snapshot manifest and keeps the content objects other snapshots share. `atlas delete --purge` removes contacts together with the rest of the tenant bucket.

## Limitations

- Contact groups (Outlook contact lists) are not exposed by the Graph contacts API and are not backed up.
- Replication and rehydrate do not cover contacts yet. `atlas replicate` refuses a contacts snapshot ID.
- Graph may not report a photo-only change in delta, so a new photo on an otherwise unchanged contact can wait until the contact itself changes.
