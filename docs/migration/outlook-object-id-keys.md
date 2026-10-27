# Outlook backups keyed by object ID

Outlook backups are keyed by the mailbox's Entra object ID instead of its primary SMTP address. This is a breaking change. Atlas does not migrate, alias, or fall back to the old keys.

## What changed

| Area               | Before                   | Now                                                |
| ------------------ | ------------------------ | -------------------------------------------------- |
| Storage key owner  | Lowercased SMTP address  | Entra object ID (`{owner_id}`)                     |
| `-m` / `--mailbox` | Address, used as the key | Address or object ID; an address is resolved first |
| Address in storage | Key segment              | Display metadata on snapshots only                 |

An address (any value containing `@`) is resolved with `GET /users/{email}` before any key is built. Any other value is used as an object ID with no Graph call.

## Why

Object IDs do not change when the primary address is renamed, and a shared mailbox conversion keeps the same ID. Renaming the address therefore keeps the same storage prefix, so the next run is incremental and the catalog shows one mailbox. Microsoft Graph also addresses users by ID, and OneDrive already keys by object ID, so both workloads now follow one convention.

## What to expect after upgrading

- Backups written under an address prefix are not reachable. Passing the address to the new version does not find them.
- The first backup of each mailbox is a full backup under the object ID prefix. Content is deduplicated per owner prefix, so the new copy is stored in full.
- Old objects stay in the bucket until they are deleted or their Object Lock retention ends.

## Steps

1. Decide whether to keep the old backups. To remove them, run the previous version before upgrading:

   ```bash
   atlas outlook delete -m user@company.com -y    # one mailbox
   atlas delete --purge                           # whole tenant bucket
   ```

   Objects under Object Lock retention are kept and reported, not treated as a failure. Keep the old version installed until the purge finishes.

2. Upgrade Atlas.

3. Run a full backup per mailbox, or let the next tenant backup take one:

   ```bash
   atlas outlook backup -m user@company.com --full
   ```

   `-m` also accepts the object ID directly, which skips the Graph lookup.

Restore and `-T` / `--target` are unchanged. They still accept an address or an ID because they only address the Graph target mailbox.
