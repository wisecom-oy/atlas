# Contacts backup

Atlas backs up each user's personal Outlook contacts, including the contact folder hierarchy and contact photos. Contacts are a separate workload from mail, with their own commands and their own storage prefix.

## Commands

```bash
atlas contacts backup -m user@company.com
atlas contacts list -m user@company.com
atlas contacts verify -m user@company.com -s ct-snap-1735689600000-a1b2c3
atlas contacts restore -m user@company.com -s ct-snap-1735689600000-a1b2c3 --target other@company.com
atlas contacts delete -m user@company.com -s ct-snap-1735689600000-a1b2c3
```

Every option is listed in the [CLI reference](/reference/cli#atlas-contacts).

## Permissions

Backup needs `Contacts.Read`. Restore needs `Contacts.ReadWrite`. See [Azure AD setup](/azure-ad-setup).

## How a backup runs

- Atlas runs a Graph delta query per mailbox. The delta cursor is stored at `contacts/_meta/{owner_id}/delta.json`.
- Each changed contact is serialised to JSON, encrypted under the tenant DEK, and stored at its SHA-256 key.
- Photos are stored under `contacts/photos/` with the same content addressing.
- Unchanged contacts reuse the keys from the previous snapshot, so a run that finds no changes writes only the new manifest and the cursor.
- Every snapshot manifest is complete on its own. A restore reads one manifest and no older ones.
- Contacts calls use the Outlook Graph throttling pool, counted per mailbox.

See [Storage layout](/operations/storage-layout#contacts) for the full key layout.

## Restore

Restore never overwrites. A contact that already exists in the target folder is skipped and counted in `contacts_skipped`. Use `--target` to restore into another mailbox. A partial restore exits `2`.

## Deletion

`atlas contacts delete -m` removes all contacts data for a mailbox. Adding `-s` removes one snapshot. `atlas delete --purge` removes contacts together with the rest of the tenant bucket.

## Limitations

- Replication is not supported. `atlas replicate` refuses a contacts snapshot ID with a clear error.
- `rehydrate` does not cover contacts yet.
