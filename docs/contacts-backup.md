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

| Operation            | Graph application permission                   |
| -------------------- | ---------------------------------------------- |
| Backup               | `Contacts.Read`                                |
| Restore              | `Contacts.ReadWrite`                           |
| List, verify, delete | None: these read and write backup storage only |

Passing a mailbox as an email address resolves it to an Entra object ID first, which needs `User.Read.All`. Passing the object ID skips that lookup.

A missing grant fails with `ATLAS_AUTH_DENIED` and names the permission to add. Mail-only app registrations do not have either, so add them before the first contacts run. See [Azure AD setup](/azure-ad-setup).

## How a backup runs

1. Atlas reads the default Contacts folder (`/contactFolders/contacts`) and walks its `childFolders` recursively.
2. Each folder gets its own Graph delta query, sent with `Prefer: IdType="ImmutableId"` so contact IDs survive moves. The delta links are stored encrypted at `contacts/_meta/{mailbox}/delta.json`.
3. Each changed contact is serialised to JSON and its photo is fetched. Both are encrypted under the tenant DEK and stored under a keyed content name (HMAC-SHA256 under a key derived from the DEK), the same naming mail and drive objects use. An object that already exists is not uploaded again.
4. Atlas writes a manifest that lists every folder and contact. Each manifest is complete on its own, so restore and verify read one manifest and never fold a chain.

A contact that fails to store keeps its entry from the previous snapshot and is named in the run's errors, while the rest of its folder is still stored. The folder keeps its old delta link (or none, if Graph rejected the old one), so the next run delivers the failed contact again. The run is then reported as unhealthy and exits `2`. Missing consent (`ATLAS_AUTH_DENIED`) or an unlicensed mailbox ends the run at once, since no further request can succeed. A run with no changes creates no snapshot. An interrupted run saves no manifest and no cursor, so it leaves no restorable snapshot; contact and photo objects it already uploaded stay in storage (and under Object Lock, if requested) and are reused by the next run.

Contacts in a folder are stored four at a time, matching the Exchange limit of four concurrent requests per mailbox. Contacts traffic counts against the Outlook Graph throttling pool.

## Restore

Restore only adds. It never overwrites or deletes a contact.

- **Folders.** A source folder maps onto the target folder at the same display-name path, and a missing folder is created parent first. Names are compared without case, as Exchange does: a target folder `team` receives the contacts of a source folder `Team`. Exchange rejects two sibling folders whose names differ only in case, so a path always names one folder.
- **Source tag.** Each restored contact carries a single-value extended property, `AtlasSourceContactId`, holding the id of the contact it was restored from.
- **Duplicates.** An entry is skipped and counted in `contacts_skipped` when the target folder already holds the original contact under the id the backup recorded, or a contact tagged with that id by this or an earlier restore. Two different people who share a display name are therefore both restored, and restoring a snapshot twice creates nothing the second time, including contacts with no name or email.
- **Contacts Atlas did not create.** A contact that has no tag and is not in the snapshot, such as the same person entered by hand or imported by another tool, matches an entry with the same display name, email addresses, phone numbers, and company (trimmed, lowercased, sorted). A contact with none of these fields never matches by content.

Every object is checked against its recorded SHA-256 before it is written. A mismatch is reported as an error naming the contact, and the restore continues. A contact whose photo upload fails still counts as restored, and the photo failure is reported separately. Missing consent ends the restore. A partial restore exits `2`.

## Deletion

`atlas contacts delete -m` removes all contacts data for a mailbox. Adding `-s` removes one snapshot manifest and keeps the content objects other snapshots share. `atlas delete --purge` removes contacts together with the rest of the tenant bucket.

## Limitations

- Contact groups (Outlook contact lists) are not exposed by the Graph contacts API and are not backed up.
- Contacts are replicated and rehydrated by mailbox (`atlas replicate -m`, `atlas rehydrate -m`) and by tenant (`atlas rehydrate --all`). A single contacts snapshot ID passed to `-s` is refused. See [Replication](/operations/replication).
- Graph may not report a photo-only change in delta, so a new photo on an otherwise unchanged contact can wait until the contact itself changes.
