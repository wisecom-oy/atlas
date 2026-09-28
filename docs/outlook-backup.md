# Outlook Backup

```bash
atlas outlook backup -m john.doe@example.com --include-contacts
atlas outlook verify -m john.doe@example.com -s <snapshot-id>
atlas outlook contacts restore -s <snapshot-id>
atlas outlook config restore -s <snapshot-id>
```

Mail backup remains the default. `--include-contacts` also captures the default Contacts folder and custom contact folders, including nested folders. Grant the application `Contacts.Read` and admin consent before enabling it. Contact restore requires `Contacts.ReadWrite`.

Contacts use one delta cursor per contact folder, separate from mail-folder cursors. Atlas saves the Graph contact JSON as an encrypted, content-addressed object, with each available photo in another encrypted object. An unchanged mailbox creates no new snapshot. Deleted contacts are recorded as tombstones, so later snapshots do not bring them back; a deleted contact folder also disappears from the restorable folder inventory. A single contact that fails backup is recorded in the encrypted cursor and retried on later runs. The backup exits as partial while any failures remain.

`atlas outlook contacts restore -s <snapshot-id>` merges contact changes through the named snapshot, recreates missing folders under their original parents, and restores contacts and photos. To use a different mailbox, pass `-T john.doe@example.com`. An existing contact with the same first email address is updated in place only when its writable fields differ; Atlas does not delete and re-create it. Distinct contacts sharing an email address remain separate. Contacts without an email address are matched by their captured writable fields, so a changed email-less contact may be created as a new contact. Restore never deletes live contacts merely because a snapshot contains a tombstone.

`atlas outlook verify` checks the contact JSON and photo blobs alongside messages. `atlas outlook restore` and `atlas outlook save` remain mail-only; use `atlas outlook contacts restore` for the address book. Contact snapshots are Graph JSON, not vCard, and a restored contact receives a new Graph ID. Atlas captures no Outlook calendar.

Contact object keys under `contacts/data/{owner_id}/{sha256}` and `contacts/photos/{owner_id}/{sha256}` expose the owner identifier and plaintext content hash to someone with bucket listing access. The blobs and manifests are encrypted, but these keys can confirm the presence of known content; see the [security model](/security#what-is-encrypted-at-rest) and [issue #446](https://github.com/wisecom-oy/atlas/issues/446). Use opaque owner IDs where possible and restrict bucket listing access.

## Mailbox configuration

Every backup run also captures the mailbox's inbox rules, master category list, and mailbox settings (automatic replies, working hours, time zone, language, and date and time formats). These use the `MailboxSettings.Read` permission that folder enumeration already needs, so no new consent is required. If the grant is missing, the run logs one warning naming `MailboxSettings.Read`, keeps the mail snapshot, and carries the previous configuration forward. A transient Graph failure is reported as a partial run and the previous configuration is kept.

The three payloads are stored together as one encrypted JSON document under `mailbox-config/{owner_id}/{sha256}`. An unchanged configuration writes no object and, if mail is also unchanged, no snapshot. The document also records the path of every folder a rule moves or copies mail to, because folder IDs do not survive into another mailbox. `atlas outlook verify` checks the configuration object that applies to the snapshot.

```bash
atlas outlook config restore -s <snapshot-id>
atlas outlook config restore -s <snapshot-id> -T jane.roe@example.com
```

Restore uses the newest configuration at or before the named snapshot and applies it in dependency order:

1. **Categories.** Missing categories are created and existing ones with the same name get the captured colour. Category names are immutable in Graph, so a renamed category is created as a new one.
2. **Mailbox settings.** Only the writable fields that differ are sent in one `PATCH`. Read-only fields such as `userPurpose` are never written.
3. **Inbox rules.** Rules are matched by display name. A rule that already exists is updated only if its writable fields differ, and a rule with no match is created. Folder actions are remapped to the target mailbox's folder at the same path, compared case-insensitively. A rule whose folder does not exist in the target, and a read-only rule managed by Exchange, is skipped and listed by name with the reason.

Restore requires `MailboxSettings.ReadWrite`. It never deletes categories or rules that exist only in the target. Skipped rules and failed writes make the command exit `2`. Restore into the snapshot owner is the default; `-T` targets another mailbox and overwrites its settings, including its automatic reply text.
