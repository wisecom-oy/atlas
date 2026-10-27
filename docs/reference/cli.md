# CLI commands

The Atlas CLI (`@wisecom/atlas-cli`) runs backup, restore, verification, and storage operations from a shell. It suits cron jobs, operator workflows, and simple deployments. Credentials come from `.env`, environment variables, or the encrypted store that `atlas config` writes (see [Configuration](/configuration)).

For Node.js applications such as custom schedulers and multi-tenant services, use the [Programmatic SDK](/reference/sdk). The SDK takes explicit config at construction time, with no `.env` dependency, and exposes the same operations as typed methods.

## Installation

```bash
npm install -g @wisecom/atlas-cli
```

A local install links `atlas` into `/usr/local/bin` or `~/.local/bin` through a postinstall hook. On a global install, the hook replaces an older Atlas command, so `atlas --version` reports the version you just installed. If `atlas` is already a shell alias or another command on your PATH, the hook skips with a warning and leaves it alone. Use `npx atlas` in that case. The hook never fails the install. Set `ATLAS_SKIP_POSTINSTALL=1` to opt out, and run `npm run link-cli --prefix node_modules/@wisecom/atlas-cli` to link manually.

pnpm and Bun block dependency lifecycle scripts by default. With pnpm, run `pnpm approve-builds`. With Bun, run `bun pm -g trust @wisecom/atlas-cli`. On Windows, global installs use npm's `.cmd` shims.

## Output width

Tables are laid out for the terminal width. When output is piped or redirected, Atlas assumes 80 columns, so long values such as site URLs and object IDs wrap onto a second line. Set `COLUMNS` to keep each row on one line:

```bash
COLUMNS=200 atlas sharepoint list-sites > sites.txt
```

Scripts that grep for an ID or parse the output will miss a value that wrapped.

## Exit codes

Scripts should branch on the exit code, not on the message text:

```bash
status=0
atlas outlook backup --mailbox "$mailbox" || status=$?
case "$status" in
  0) echo "Complete" ;;
  2) echo "Incomplete run: inspect the reported items" >&2 ;;
  3) echo "Transient failure: schedule a later attempt" >&2 ;;
  4|5|6|7|8|9) echo "Operator action required; do not retry unchanged" >&2 ;;
  *) echo "Command failed; inspect stderr" >&2 ;;
esac
exit "$status"
```

| Code | Meaning                                                                                                                | Action                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success, help, or a command with no failure reported                                                                   | Continue normally.                                                                                                               |
| `1`  | Unexpected or unclassified failure, invalid command usage, or a command-reported failure without a typed exception     | Inspect stderr. Do not assume the failure is transient.                                                                          |
| `2`  | Partial backup, restore, or save: item errors, skipped files, integrity failures, or a soft interrupt                  | Inspect the partial result before relying on it.                                                                                 |
| `3`  | Throttling retry budget exhausted, a recognized network error, or transient HTTP `429`, `500`, `502`, `503`, `504`    | Schedule a later attempt. A timeout does not prove a write was never committed, so inspect partial work before repeating a restore. |
| `4`  | `ATLAS_AUTH_DENIED`, `ATLAS_MAILBOX_NOT_LICENSED`, or an unwrapped HTTP `401` or `403`                                 | Correct credentials, permissions, admin consent, or licensing before retrying.                                                   |
| `5`  | `ATLAS_WRONG_PASSPHRASE`                                                                                               | Supply the original tenant passphrase. Never pad it or delete the wrapped key. If it is correct, investigate possible corruption. |
| `6`  | `ATLAS_CONFIG_INVALID`, including failure to load the CLI configuration                                                | Correct the configuration or its storage access.                                                                                 |
| `7`  | `ATLAS_NOT_FOUND` or an unwrapped HTTP `404`                                                                           | Check the selected resource and identifiers.                                                                                     |
| `8`  | `ATLAS_OBJECT_LOCK_RETAINED`                                                                                           | Respect retention or legal hold. Repeating the same deletion cannot bypass it.                                                   |
| `9`  | `ATLAS_CONTENT_UNREADABLE`                                                                                             | The stored bytes are intact but cannot be parsed back. Repeating the command will not help. Extract the raw content with `save`. |

Fatal exceptions map to these categories. Failures the command reports itself stay `1`: failed verification, `storage-check` reporting an unready bucket, and `config validate` reporting a failed probe. Per-item failures already reported as partial stay `2`, and their messages are not reclassified.

An explicit Atlas category takes precedence over transport details. Network detection reads structured Node error codes, including nested `cause`, never message text. An error that only says "socket hang up" is unclassified unless it carries a recognized code. A process killed by a signal may appear as `128 + signal` in the shell. That is separate from these categories.

### Fatal error diagnostics

```text
[x] Consent required
[x]   Atlas code: ATLAS_AUTH_DENIED
[x]   Cause: Permission denied
[x]   HTTP status: 403
[x]   Transport code: ErrorAccessDenied
```

The CLI prints the Atlas code separately from the Graph code, HTTP status, response body, or AWS error name. Unwrapped HTTP `401`, `403`, `404`, and `429` responses also receive their Atlas category. Fatal diagnostics, including `DEBUG` stacks, go to stderr so redirected stdout stays clean.

Diagnostics can contain tenant identifiers and sensitive content. Redact them before sharing logs.

## Short flags

A short flag means one thing across the CLI.

| Flag | Meaning                                       | Notes                                                                              |
| ---- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `-s` | `--snapshot`                                  | Every command that acts on a snapshot. `stats` does not accept it.                 |
| `-o` | `--owner`                                     | A drive owner. `--output` has no short flag on any command.                        |
| `-f` | `--folder` on Outlook, `--file` on the drives | One value each. Repeat `-f` to name several Outlook folders.                       |
| `-t` | `--tenant`                                    | Every command.                                                                     |
| `-m` | `--mailbox`                                   | Every command that acts on a mailbox. Takes an email address or Entra object ID.  |

A retired spelling is rejected rather than reinterpreted, and the error names its replacement:

```console
$ atlas stats -s https://contoso.sharepoint.com/sites/Engineering
error: option '-s <value>' argument 'https://...' is invalid. -s no longer means --site in v5.0.0. Pass --site instead.
```

`--site` has no short flag, so nothing can shadow `-s`.

## Identifiers

Mailboxes and drive owners can be passed as an email address or an Entra object ID. An email is resolved through Microsoft Graph before any storage key is built. Object IDs are used as given. Backups are keyed by object ID, so the address is display metadata only.

Sites accept a browser URL (`https://contoso.sharepoint.com/sites/Engineering`), the Graph short form (`contoso.sharepoint.com:/sites/Engineering`), or a site ID with or without its hostname (`contoso.sharepoint.com,<siteGuid>,<webGuid>` or `<siteGuid>,<webGuid>`). This applies to every command that takes `--site`, including `replicate` and `rehydrate`.

Commands that read existing backups (`list-snapshots`, `list-versions`, `save`, `verify`, `status`, `delete`, the source site of `restore`, `atlas stats --site`, `replicate`, and `rehydrate`) drop the hostname from a site ID with string handling alone. They make no Graph call, so backups of a site deleted from SharePoint stay reachable and disaster recovery works while Graph is unavailable. `backup` and `restore --target-site` always resolve through Graph because they work on the live site.

Owner and site IDs are case-insensitive. They are lowercased before they become storage keys, so one identifier always addresses one tree. Storage keys use `<siteGuid>,<webGuid>`, so a SharePoint domain rename does not start a second backup history. See [SharePoint storage layout](../sharepoint-backup.md#storage-layout).

## atlas outlook

Outlook mailbox backup, restore, and management commands. Mailbox operations live under this group. Storage and replication commands stay at the root.

Mailboxes are identified by Entra object ID. `-m` accepts an email address or an object ID. A value containing `@` is resolved through `GET /users/{email}` before any storage key is built. Backups written by v5 were keyed by address; see [Migrating to v6](/migration/v6).

::: warning Scope flags: `-s` and `-m` together
`restore`, `list`, and `save` select what to act on with `-s, --snapshot` (one snapshot) or `-m, --mailbox` (every snapshot for a mailbox).

`list` and `save` use `-s`, warn that `-m` was ignored, and continue. A snapshot ID names exactly one thing, so it is the narrower request, and Atlas never widens it silently.

`restore` refuses the pair and exits `1`. Earlier releases used `-m` to mean "restore this snapshot into that mailbox", so guessing would decide which mailbox receives the mail. To choose the destination, use `-T, --target`, which works in both modes:

```bash
atlas outlook restore -s <snapshot-id> -T other@company.com
```

`-T` selects where mail lands, never what gets restored.
:::

### atlas outlook backup

Back up one mailbox to object storage, with a per-folder progress dashboard. `-m` is required. To back up several mailboxes, list them with `atlas outlook mailboxes` and loop from your scheduler. Atlas does not fan out across mailboxes itself.

```bash
atlas outlook backup -m user@company.com                               # incremental backup
atlas outlook backup -m user@company.com --full                        # ignore saved delta state
atlas outlook backup -m user@company.com -f Inbox -f "Sent Items"      # specific folders only
atlas outlook backup -m user@company.com -P 50                         # larger page size
atlas outlook backup -m user@company.com --retention-days 30 --lock-mode governance
atlas outlook backup -m user@company.com --retention-days 365 --lock-mode compliance
atlas outlook backup -t <tenant-id> -m user@company.com                # explicit tenant
```

| Option                        | Description                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `-m, --mailbox <id>`          | Mailbox email address or Entra object ID to back up (required)               |
| `-f, --folder <name>`         | Limit to one folder by name or path. Repeat for several (see below).         |
| `--full`                      | Ignore saved delta links and run a full enumeration                          |
| `-P, --page-size <n>`         | Graph API page size per delta request (1 to 100, default 10)                 |
| `--retention-days <n>`        | Apply Object Lock retention for `n` days                                     |
| `--lock-mode <mode>`          | Object Lock mode, `governance` or `compliance`. Requires `--retention-days`. |
| `-t, --tenant <id>`           | Override the tenant ID from config                                           |
| `--exclude-junk`              | Skip the Junk Email folder and its subfolders                                |
| `--include-recoverable-items` | Also back up hard-deleted and hold-retained mail (see below)                 |

`--lock-mode` only applies with `--retention-days`. Passing it alone is rejected, so a run meant to be immutable cannot exit `0` with unprotected data. Retention without a mode defaults to `governance`. Retention is fail-closed: if the bucket has versioning or Object Lock disabled, or cannot honour the requested mode, the run aborts instead of writing unprotected data.

#### Which folders are backed up

Every mail folder in the mailbox is backed up at any depth, including folders Outlook treats as special:

| Folder                                                      | Backed up | Note                                                                                       |
| ----------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| Inbox, Sent Items, Deleted Items, Archive, and user folders | Yes       | Including nested subfolders                                                                |
| **Drafts** and **Outbox**                                   | Yes       | Unsent work exists nowhere else                                                            |
| **Junk Email**                                              | Yes       | Opt out with `--exclude-junk`. Junk is evidence in a phishing or business email case.      |
| Hidden folders (`isHidden`)                                 | Yes       | Enumerated explicitly, since Graph omits them by default                                   |
| Hidden Exchange system folders                              | No        | A short deny list of client-state folders, such as `Conversation Action Settings`, matched only when Exchange also reports them hidden |
| In-Place Archive mailbox                                    | No        | Graph cannot read it. See [In-Place Archive is out of scope](../security.md#in-place-archive-is-out-of-scope). |
| **Recoverable Items**                                       | Opt-in    | `--include-recoverable-items`. See below.                                                  |

Anything skipped is reported at the end of the run and recorded in the snapshot manifest with its reason:

```
[!] 1 folder(s) not backed up:
      Junk Email (skipped by --exclude-junk)
```

::: warning Drafts and Outbox are included from 4.1.0
Earlier versions skipped Drafts and Outbox without reporting it. Snapshots taken from 4.1.0 include them, so the first backup after upgrading is larger for mailboxes with unsent mail. Existing snapshots are unchanged.
:::

#### Recoverable Items

Mail that arrives and is hard-deleted between two backups never appears in a delta page. Its only copy in the tenant is in the Recoverable Items subtree, which an ordinary backup does not read. Once Exchange's retention window expires, the item is gone from the tenant and from every snapshot.

```bash
atlas outlook backup -m user@company.com --include-recoverable-items
```

| Subfolder          | Backed up | Contains                                                                    |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| `Deletions`        | Yes       | Items removed from Deleted Items, recoverable by the user for 14 to 30 days |
| `Purges`           | Yes       | Hard-deleted items retained only by litigation hold or single item recovery |
| `DiscoveryHolds`   | Yes       | Hard-deleted items retained by an In-Place Hold or retention policy         |
| `SubstrateHolds`   | Yes       | Original copies of held Teams messages and modified held items              |
| `Versions`         | No        | Pre-modification copies whose item shape is not a message                   |
| `Calendar Logging` | No        | Calendar change audit trail                                                 |
| `Audits`           | No        | Mailbox audit log entries                                                   |

The flag is off by default. On a mailbox under litigation hold, the dumpster can be as large as the mailbox, and that cost should be a deliberate choice. With the flag off, request volume matches earlier runs. The subtree is located only when the flag is set. Subfolders Atlas does not recognize are reported rather than guessed at, so a new Exchange subfolder shows up as a visible gap.

::: warning Restoring purged mail is opt-in twice
Entries captured this way are marked in the manifest. `restore` and `save` exclude them by default, so an ordinary restore does not resurrect deleted mail or mail that exists only because a hold kept it. Pass `--include-recoverable-items` to the restore or save command as well, including when naming one message with `--message`.

Graph offers no way to write into Recoverable Items. Recovered items land in the normal restore folder. See [Recoverable Items and legal hold](../security.md#recoverable-items-and-legal-hold) for the compliance implications.
:::

::: warning Exit codes for backup, restore, and save
This applies to Outlook, OneDrive, and SharePoint. `0` means complete with no errors. `2` means **partial**: a snapshot was saved, but per-folder or per-file errors or a soft interrupt (Ctrl+C) left the run incomplete. Failed items are listed on stderr. A partial backup is restorable but missing the listed items.

`restore` and `save` follow the same contract. A file they cannot decrypt or write is counted as skipped, and any skipped file exits `2`. An archive missing some files is not a success, and a cron job that only checks for `0` must be able to see the difference.

An **integrity failure** also exits `2`. A message whose decrypted bytes do not match its manifest checksum is still written, but it can no longer be confirmed as the backed-up content. The ciphertext decrypted correctly and the stored checksum disagrees, which points at the manifest or at an object that was replaced. Run [`atlas outlook verify`](#atlas-outlook-verify) to find the scope before trusting the archive.
:::

#### Page size, nested folders, and immutability

`--page-size` sets the `Prefer: odata.maxpagesize` hint for each delta request. The server can return fewer items when messages are large. Smaller pages make progress save more often during an interrupt. Larger pages use fewer round trips. The default of 10 suits most mailboxes.

Each new or changed message costs one `/$value` request for its MIME. Reactions are read per delta page in one `$batch` round trip per 20 messages, so a backup of N messages adds N/10 round trips at the default page size and N/20 at `--page-size 100`. Each message in the batch still counts once against the mailbox's 10,000-request window. See [Delta sync](/operations/delta-sync#reactions).

Atlas walks the whole folder hierarchy, not only the top-level folders that `GET /users/{id}/mailFolders` returns. Folders are identified by root-relative path, such as `Inbox/Projects/2026`, and `status`, backup progress, and `save` show that path.

A `--folder` value matches either a full path (`Inbox/Projects`) or a folder name at any depth (`Projects`), case-insensitively. A match always includes everything beneath it, so `--folder Inbox` covers `Inbox`, `Inbox/Projects`, and `Inbox/Projects/2026`. Use the full path when one name exists under several parents. Excluded system folders are pruned with their subtrees. Recursion stops at 300 levels, matching Exchange's own limit. Deeper folders are skipped with a warning.

`--retention-days` makes the backup immutable-requested. Atlas resolves the retention to a UTC `retain_until`, probes whether the bucket supports versioning and Object Lock, and fails before writing if it does not.

### atlas outlook verify

Verify the restorable state of a snapshot. Verification walks the snapshot's merged manifest chain, the same view `restore` uses. It checks every referenced object, including message bodies and attachments. Each object is downloaded, decrypted, re-hashed with SHA-256, and compared with the manifest checksum. AES-256-GCM authentication rejects tampered ciphertext during decryption.

```bash
atlas outlook verify -m user@company.com -s <snapshot-id>
atlas outlook verify -m user@company.com -s <snapshot-id> -t <tenant-id>
atlas outlook verify -m user@company.com -s <snapshot-id> --fast
```

| Option                        | Description                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `-m, --mailbox <email-or-id>` | Mailbox that owns the snapshot (required)                                                      |
| `-s, --snapshot <id>`         | Snapshot identifier to verify (required)                                                       |
| `-t, --tenant <id>`           | Override the tenant ID from config                                                             |
| `--fast`                      | Existence checks only (a `HeadObject` per referenced key). No download, decryption, or hashing. |

The check covers the target delta manifest and every older manifest for the same mailbox, deduplicated newest first. A corrupt or missing object from an older run fails verification of every later snapshot that still references it.

Entries with no stored blob, such as large attachments skipped by pre-v2.1.0 backups, are reported as **unverifiable**. They fail the run, because a restore cannot reproduce them.

`--fast` confirms that every referenced object exists. It catches the most common damage, such as lifecycle deletion, failed replication, or manual cleanup, at near-zero bandwidth. Run full verification on a schedule, since it also checks ciphertext integrity through the GCM tag.

Only damage counts as a failed object: a key the bucket reports as absent (`NoSuchKey` or `NotFound`), ciphertext that fails its GCM tag, or a checksum mismatch. Any other storage error stops the run and exits with its own category. A `403` exits `4`, and a `503` or network error exits `3`. An expired credential or an outage says nothing about the backup, so it is never reported as a list of failed objects.

### atlas outlook restore

Restore emails from a backup to a Microsoft 365 mailbox.

**Snapshot mode** restores one snapshot:

```bash
atlas outlook restore -s <snapshot-id>
atlas outlook restore -s <snapshot-id> -f Inbox
atlas outlook restore -s <snapshot-id> --message 42
atlas outlook restore -s <snapshot-id> -T target@company.com
```

**Mailbox mode** combines every snapshot for a mailbox, deduplicates them, and restores the result:

```bash
atlas outlook restore -m user@company.com
atlas outlook restore -m user@company.com -f Inbox
atlas outlook restore -m user@company.com --start-date 2026-01-01
atlas outlook restore -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30
atlas outlook restore -m user@company.com -T other@company.com
atlas outlook restore -m user@company.com -T other@company.com -f Inbox
```

| Option                        | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `-s, --snapshot <id>`         | Restore from a specific snapshot                                      |
| `-m, --mailbox <email-or-id>` | Restore from all snapshots for this mailbox                           |
| `-T, --target <email>`        | Target mailbox for a cross-mailbox restore (defaults to the source)   |
| `-f, --folder <name>`         | Restore only messages from this folder or its subfolders              |
| `--message <ref>`             | Restore one message by its `#` index from `atlas outlook list`        |
| `--start-date <YYYY-MM-DD>`   | Include snapshots created on or after this date                       |
| `--end-date <YYYY-MM-DD>`     | Include snapshots created on or before this date                      |
| `-t, --tenant <id>`           | Override the tenant ID from config                                    |
| `--include-recoverable-items` | Also include hard-deleted and hold-retained mail (excluded by default) |

Exactly one of `--snapshot` or `--mailbox` is required. Passing both exits `1` (see [atlas outlook](#atlas-outlook)). `-T` works in either mode. In mailbox mode, the newest version of each message wins. Cross-mailbox restores keep the source folder names, and nested folders are recreated under the `Restore-{timestamp}` root. For example, `Inbox/Projects/2026` restores to `Restore-.../Inbox/Projects/2026`.

Snapshot mode reads the snapshot's whole chain: the target plus every older snapshot of the same mailbox, with the newest version of each message winning. Snapshots taken after the target and snapshots of other mailboxes are excluded. This is the set that `atlas outlook verify -s` checks, so a snapshot that verifies restores the same messages. A `--message` index counts the target snapshot's own messages, as `atlas outlook list -s` prints them. A full message ID matches anywhere in the chain.

A message deleted from the mailbox before a snapshot is not restored from it. Each backup records the message IDs Graph reported as removed, and those IDs hide older copies in the chain. Mailbox mode applies the same rule across the snapshots it reads. Removals are recorded only by a run that finished every folder without `--folder`, because a moved message appears as a removal from one folder and a new message in another. Older snapshots and runs that skip removals keep the earlier behavior, so a message deleted in those runs still comes back. See [Delta sync](/operations/delta-sync#deleted-and-moved-messages-outlook).

Restored messages keep their original received and sent timestamps. They appear as received mail rather than drafts, and include all backed-up attachments. Attachments larger than 3 MB use Graph upload sessions.

A message that receives fewer attachments than its snapshot holds is listed as a warning, for example `<message-id>: 1 of 2 attachments restored`. A failed upload is an error and exits `2`. A legacy attachment that was never backed up is skipped with a warning only.

Messages archived as RFC 5322 MIME are parsed at restore time and recreated through Graph's JSON message-create path. Graph's MIME import always marks the created message as a draft, so importing would flood the mailbox with drafts. The restored copy is normal mail with its original timestamps, but it does not carry the original `Received:` chain. For the original bytes, use [`atlas outlook save`](#atlas-outlook-save).

`-f` matches on the `folder_id` recorded in the manifest. Snapshots written before Atlas stamped that field recover it from the Graph JSON entries. A MIME entry has no folder to recover from, because RFC 822 does not record one. `-f` skips those entries and reports the count on stderr. Restore or save without `-f` to include them. Snapshots from current versions are unaffected.

### atlas outlook list

Browse backed-up data at three levels. Subjects are hidden by default.

```bash
atlas outlook list                              # all mailboxes with summary stats
atlas outlook list -m user@company.com          # all snapshots for a mailbox
atlas outlook list -s <snapshot-id>             # messages inside a snapshot (first 50)
atlas outlook list -s <snapshot-id> --all       # all messages
atlas outlook list -s <snapshot-id> -S          # reveal email subjects
```

| Option                        | Description                                                   |
| ----------------------------- | ------------------------------------------------------------- |
| `-m, --mailbox <email-or-id>` | Show snapshots for this mailbox                               |
| `-s, --snapshot <id>`         | Show messages inside this snapshot                            |
| `--all`                       | Show all messages (the default caps at 50)                    |
| `-S, --subjects`              | Reveal subjects (hidden by default for data protection)       |
| `-t, --tenant <id>`           | Override the tenant ID from config                            |

The mailbox overview includes a `Type` column, taken from the newest manifest that recorded a purpose (`user`, `shared`, `room`, and so on). It shows `--` when none was recorded.

`list -s` shows only the messages recorded by that backup run, not the whole chain that `restore -s` and `save -s` read. Its `#` index is what `--message` resolves against.

### atlas outlook read

Decrypt and display one backed-up message. Reference it by its `#` index from `atlas outlook list`, or by its full Graph message ID.

```bash
atlas outlook read -s <snapshot-id> --message 34
atlas outlook read -s <snapshot-id> --message 34 --raw
atlas outlook read -s <snapshot-id> --message 34 --raw > message.eml
```

| Option                | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `-s, --snapshot <id>` | Snapshot that contains the message (required)                         |
| `--message <ref>`     | Message `#` from `atlas outlook list`, or full Graph message ID (required) |
| `--raw`               | Output the stored object verbatim instead of the formatted view       |
| `-t, --tenant <id>`   | Override the tenant ID from config                                    |

With `--raw`, the output depends on the stored format. Messages archived as RFC 5322 MIME, which is what current snapshots write, are written to stdout as the decrypted MIME bytes, with no banner, colour, or added newline. Redirected output is a valid `.eml` file with its original `Received:` chain, `Authentication-Results`, and any S/MIME payload intact. Use it to hand a message to an investigator or to check a DKIM signature.

A legacy entry stored as Graph JSON prints as pretty-printed JSON with two-space indentation. To see which format an entry uses, check the `payload_format` field in its manifest entry. `"mime"` means original bytes. A missing field means legacy JSON.

The formatted view is the same for both formats: subject, from, to, cc, date, a separator, and the decoded `text/plain` body. If there is no plain-text part, Atlas falls back to the HTML part converted to text. Attachment name, MIME type, and size are listed below the body, including attachments embedded in archived MIME.

### atlas outlook save

Export backed-up mail as standard `.eml` files (RFC 5322) in a zip archive. MIME messages are written **byte for byte** from the stored object, so the exported file is the message Exchange received. Legacy JSON entries are rebuilt into `.eml` at export time. Attachments are embedded as MIME parts in both cases. Every message and attachment is SHA-256 verified after decryption unless `--skip-verify` is set.

::: warning Exported files on Windows are marked as internet-sourced
On Windows, Atlas stamps the archive with Mark-of-the-Web: a `Zone.Identifier` stream carrying `ZoneId=3`. The content came from a tenant over the network, and Atlas does not vet it, so the export must not remove a protection the file would have had from a browser or mail attachment. Office opens recovered documents in Protected View with macros blocked.

The mark propagates. Windows Explorer and WinRAR copy it to every extracted file. When you have decided the content is trustworthy, clear it:

```powershell
Get-ChildItem -Recurse .\Restore-2026-03-10 | Unblock-File
```

macOS and Linux write nothing, since they have no equivalent. If the target filesystem cannot store alternate data streams, such as FAT32 or exFAT media or an SMB share on a non-NTFS server, the export still succeeds and logs a warning.
:::

**Snapshot mode:**

```bash
atlas outlook save -s <snapshot-id>
atlas outlook save -s <snapshot-id> -f Inbox
atlas outlook save -s <snapshot-id> --message 42
atlas outlook save -s <snapshot-id> --output ~/Downloads/backup.zip
atlas outlook save -s <snapshot-id> --skip-verify
```

**Mailbox mode:**

```bash
atlas outlook save -m user@company.com
atlas outlook save -m user@company.com -f Inbox
atlas outlook save -m user@company.com --start-date 2026-01-01
atlas outlook save -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30
```

| Option                        | Description                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `-s, --snapshot <id>`         | Save from a specific snapshot                                          |
| `-m, --mailbox <email-or-id>` | Save from all snapshots for this mailbox                               |
| `-f, --folder <name>`         | Save only messages from this folder or its subfolders                  |
| `--message <ref>`             | Save one message by its `#` index from `atlas outlook list`            |
| `--start-date <YYYY-MM-DD>`   | Include snapshots created on or after this date                        |
| `--end-date <YYYY-MM-DD>`     | Include snapshots created on or before this date                       |
| `--output <path>`             | Output file path (default: `Restore-<timestamp>.zip`)                  |
| `--skip-verify`               | Skip SHA-256 integrity checks (faster on low-power systems)            |
| `-t, --tenant <id>`           | Override the tenant ID from config                                     |
| `--include-recoverable-items` | Also include hard-deleted and hold-retained mail (excluded by default) |

With both `-s` and `-m`, the named snapshot is exported and `-m` is ignored with a warning (see [atlas outlook](#atlas-outlook)). Earlier releases exported the whole mailbox silently in this case.

The archive mirrors the Outlook folder hierarchy:

```
Restore-2026-03-10T14-30-00.zip
  Inbox/
    2026-03-10_143022_Meeting-with-client.eml
    2026-03-10_090115_Weekly-report.eml
  Sent Items/
    2026-03-09_161200_Re-Project-update.eml
  Archive/
    2026-01-15_080000_Old-thread.eml
```

File names use `YYYY-MM-DD_HHmmss_Sanitized-subject.eml`, with the time taken from `receivedDateTime`, so they sort chronologically. Duplicate names within a folder get numeric suffixes (`_1`, `_2`).

A mailbox that was backed up before v4 and kept receiving incremental snapshots has both legacy JSON entries and MIME entries. `save` walks the whole chain and writes an `.eml` for each, regardless of format. If the output file already exists, Atlas asks `Overwrite? [Y/n]` before it proceeds.

### atlas outlook delete

Delete backed-up mail data behind a confirmation prompt. This command covers mail only. For a tenant-wide purge, use [`atlas delete`](#atlas-delete).

```bash
atlas outlook delete -m user@company.com        # all data and manifests for a mailbox
atlas outlook delete -s <snapshot-id>           # one snapshot manifest (data retained)
atlas outlook delete -m user@company.com -y     # skip the confirmation prompt
```

| Option                        | Description                                               |
| ----------------------------- | --------------------------------------------------------- |
| `-m, --mailbox <email-or-id>` | Delete all data, attachments, and manifests for a mailbox |
| `-s, --snapshot <id>`         | Delete one snapshot manifest (data objects retained)      |
| `-y, --yes`                   | Skip the confirmation prompt                              |
| `-t, --tenant <id>`           | Override the tenant ID from config                        |

Atlas deletes manifests first, then data objects. If a delete is interrupted, the leftover objects are orphan blobs, which are harmless, rather than manifests that point at missing data. `--snapshot` removes only the manifest, because other snapshots may reference the same blobs.

Every delete removes the object together with all of its noncurrent versions. In a versioned bucket, a plain key delete only writes a delete marker, and the bytes stay retrievable. Atlas removes the versions too, so a deletion that reports success has erased the data.

When Object Lock retention protects objects, delete commands exit non-zero and report the retained items separately. "Retained" means the backend cited Object Lock as the reason. Those objects become deletable when retention expires. Other failures, such as an IAM denial or an unreachable endpoint, are reported as failures because they will not clear on their own.

### atlas outlook status

Check whether a mailbox backup is current. This command does **not** run a backup. It queries the Graph delta endpoint with the saved delta links from the latest manifest to detect pending changes.

```bash
atlas outlook status -m user@company.com
atlas outlook status -m user@company.com -t <tenant-id>
```

| Option                        | Description                    |
| ----------------------------- | ------------------------------ |
| `-m, --mailbox <email-or-id>` | Mailbox to check (required)    |
| `-t, --tenant <id>`           | Override the tenant ID from config |

Example output:

```
╭────────────────╮
│  Atlas Status  │
╰────────────────╯
Tenant:  ec216cb5-...
Mailbox: user@company.com
[*] Last backup: 2026-03-18 14:30 (snap-abc123)

Folder      Status           Pending
----------  ---------------  -------
Inbox       up-to-date             0
Sent Items  3 change(s)            3
Archive     never backed up        -

[*] Overall: 3 pending change(s), 1 folder(s) never backed up across 3 folder(s)
```

### atlas outlook mailboxes

List tenant mailboxes from Microsoft Graph. The data is live, not taken from the backup catalog. The output shows each mailbox's Entra object ID (the value to pass to `-m`), email address, display name, Exchange Online license status, account status, mailbox type, and creation date. When permitted, it also shows mailbox size and In-Place Archive state.

```bash
atlas outlook mailboxes
atlas outlook mailboxes --licensed-only
atlas outlook mailboxes -t <tenant-id>
```

| Option              | Description                                                                             |
| ------------------- | --------------------------------------------------------------------------------------- |
| `--licensed-only`   | Show only mailboxes with an active Exchange Online license (excludes shared mailboxes)  |
| `-t, --tenant <id>` | Override the tenant ID from config                                                      |

Mailbox size requires the `Reports.Read.All` Graph permission. Without it, the Size column is omitted without an error.

The `Type` column shows the Graph `mailboxSettings.userPurpose` value (`user`, `shared`, `room`, `equipment`, and so on). To keep discovery fast, Atlas resolves it only for unlicensed mailboxes. `--` means the purpose was not resolved. `--licensed-only` excludes shared mailboxes, which are usually unlicensed.

::: warning An In-Place Archive is not backed up
The `Archive` column comes from the same `Reports.Read.All` report and shows whether a mailbox has an **In-Place Archive** (Online Archive). Graph cannot read archive mailboxes, so that content is outside backup scope. The command prints a warning naming each affected mailbox.

`--` means **unknown**, not "no archive". Either the permission is missing or the report left out the column. Atlas does not report coverage it cannot confirm.

This is not the `Archive` folder used by Outlook's Archive button. That folder lives in the primary mailbox and is backed up normally. See [In-Place Archive is out of scope](../security.md#in-place-archive-is-out-of-scope).
:::

## atlas delete

Tenant-wide deletion across every workload. This is a top-level command because the purge covers the whole bucket, not only mail.

```bash
atlas delete --purge        # delete everything in the tenant bucket
atlas delete --purge -y     # skip the typed confirmation
```

| Option              | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `--purge`           | Delete all data, manifests, and encryption keys. Irreversible.             |
| `-y, --yes`         | Skip the typed confirmation, for scheduled and scripted runs               |
| `-t, --tenant <id>` | Override the tenant ID from config. The confirmation checks against this ID. |

`atlas delete` without `--purge` exits non-zero and deletes nothing. For scoped deletes, use `atlas outlook delete`, `atlas onedrive delete`, or `atlas sharepoint delete`.

Interactively, the purge asks you to type the tenant ID and aborts on any other input:

```
[!] This will delete ALL data for tenant <tenant-id> across Outlook, OneDrive and SharePoint (data, manifests, encryption keys)
Type the tenant ID to confirm:
```

A single keypress is not enough here. A mistyped `y` is not the risk. The risk is a purge aimed at the wrong tenant, and typing the target ID is the only prompt that catches that. Scoped deletes keep a single-keypress `y/n` prompt on purpose. Making every delete laborious would train operators to pass `-y` everywhere, which would remove the guard that matters. `-y` bypasses the prompt for scheduled jobs and the end-to-end suite.

The purge sweeps the whole bucket rather than a fixed list of prefixes. Outlook, OneDrive, SharePoint, the identity registry, and any tree a later release adds are all removed. The encrypted data key at `_meta/dek.enc` is deleted last, and only once nothing else survives. Removing the key while ciphertext remains would leave data that can be neither restored nor confirmed erased. This is irreversible. All data for the tenant becomes permanently inaccessible.

Before v2.2.0 this was `atlas outlook delete --purge`. That flag no longer exists, so scripts must call `atlas delete --purge`.

## atlas onedrive

Back up, restore, and verify OneDrive files per user, using Graph delta sync. Blobs and manifests are stored under the `onedrive/` prefix of the tenant bucket (see [OneDrive backup](/onedrive-backup)).

A snapshot is a delta, so its manifest lists only what changed in that run. `restore`, `save`, and `verify` read the snapshot's **manifest chain**: the target manifest plus every older manifest for the same owner. The chain is merged newest first and deduplicated by drive item. Restoring the newest snapshot therefore returns the whole drive as it stood at that time.

A file whose newest entry is a deletion stays deleted. The tombstone overrides the older stored version, so a restore never brings back a file the user removed.

`--full`, a changed `--folder`, and an expired delta link all replace the incremental delta with an enumeration of the drive. An enumeration lists only what currently exists. When an enumeration finishes, Atlas writes a tombstone for each stored file it did not return. The comparison covers the re-crawled drive, and the `--folder` scope when one is set. An interrupted run writes no tombstones, because a partial listing proves nothing about absence. SharePoint applies the same rule per document library.

```bash
atlas onedrive backup -o user@company.com
atlas onedrive backup -o user@company.com --full
atlas onedrive backup -o user@company.com --folder /Projects
atlas onedrive restore -o user@company.com -s od-snap-1735689600000-a1b2c3
atlas onedrive restore -o user@company.com -s od-snap-123 --destination /DR-drill
atlas onedrive restore -o user@company.com -s od-snap-123 --in-place
atlas onedrive restore -o user@company.com -s od-snap-123 --target-owner other@company.com
atlas onedrive restore -o user@company.com -s od-snap-123 --conflict replace
atlas onedrive list-snapshots -o user@company.com
atlas onedrive list-versions -o user@company.com -f "Documents/report.docx"
atlas onedrive restore-version -o user@company.com -f "Documents/report.docx" --version 3.0
atlas onedrive restore-version -o user@company.com --before 2026-03-10T00:00:00Z
atlas onedrive restore-version -o user@company.com --before 2026-03-10T00:00:00Z --path /Projects --in-place
atlas onedrive verify -o user@company.com -s od-snap-1735689600000-a1b2c3
atlas onedrive status -o user@company.com
atlas onedrive delete -o user@company.com -s od-snap-123
atlas onedrive delete -o user@company.com -y
```

| Subcommand        | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `backup`          | Incremental sync. Use `--full` to ignore saved delta state.                  |
| `restore`         | Restore files from a snapshot to the owner's or another user's OneDrive     |
| `list-snapshots`  | List snapshot IDs and timestamps for the owner                              |
| `list-versions`   | List indexed versions of one file (`-f`, a file ID or path)                 |
| `restore-version` | Push stored file versions back into the drive, one file or a whole rollback |
| `verify`          | Decrypt manifests and blobs for a snapshot, and check SHA-256 and index rows |
| `status`          | Report pending Graph changes per drive, without backing up                  |
| `delete`          | Delete the owner's OneDrive backups, or one snapshot                        |

**`atlas onedrive backup`**

| Option                 | Description                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `-o, --owner <id>`     | User email or Entra object ID (required)                                                                     |
| `--full`               | Force a full crawl, ignoring saved delta links                                                               |
| `--folder <path>`      | Back up only this folder and its subfolders (see below)                                                      |
| `--retention-days <n>` | Apply Object Lock **default retention** for `n` days (see below)                                             |
| `--lock-mode <mode>`   | Object Lock mode, `governance` or `compliance` (default `governance`). Requires `--retention-days`.          |
| `-t, --tenant <id>`    | Override the tenant ID from config                                                                           |

A live dashboard shows one row per drive. Each row goes from fetching changes, to per-item progress with rate and ETA, to `[ok]` with stored, deduplicated, and version counts. An incremental run with no changes shows `[==] up to date`. Non-interactive runs (cron and CI) print one plain log line per finished drive.

::: details Object Lock for OneDrive and SharePoint
Outlook stamps retention on each object write. OneDrive and SharePoint instead apply immutability as **bucket default retention** (`PutObjectLockConfiguration`). Every new object version inherits the lock, including files, file versions, manifests, and delta cursors, so no write path can skip it. The setting persists on the bucket and covers later writes from any command. The bucket must be lock-capable, created with Object Lock (see `atlas storage-check`). Otherwise the backup fails with `ObjectLockUnsupportedError`. Small objects that are overwritten often, such as cursors and indexes, accumulate locked noncurrent versions until retention expires. The bucket housekeeping lifecycle rules remove them afterwards.
:::

`--folder` filters the result of a drive-wide delta, rather than the query. The run still enumerates the whole drive, but it downloads, hashes, and writes only items inside the folder. A saved delta link records how far the **drive** was consumed. Resuming one under a different scope would skip changes the earlier run filtered out. Changing `--folder` between runs, or switching between scoped and unscoped backups, therefore forces a full re-crawl. Repeated runs with the same value stay incremental. A scoped snapshot contains only that folder, so it is not a substitute for a whole-drive backup unless the scope covers everything you need.

**`atlas onedrive restore`**

| Option                     | Description                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- |
| `-o, --owner <id>`         | User email or Entra object ID (required)                                        |
| `-s, --snapshot <id>`      | Snapshot to restore from (required)                                             |
| `--target-owner <id>`      | Restore to another user's OneDrive (defaults to the owner)                      |
| `--destination <path>`     | Folder to restore under, created if missing (default: `/Restore-<timestamp>`)   |
| `--in-place`               | Restore to the original paths instead of a restore root                         |
| `--name <filename>`        | Rename the restored file. Rejected unless exactly one file matches.             |
| `--file-filter <paths...>` | Restore only specific files, by ID or path                                      |
| `-c, --conflict <mode>`    | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`)        |
| `-t, --tenant <id>`        | Override the tenant ID from config                                              |

A drive restore nests under `/Restore-<timestamp>` at the target drive root and recreates the original folder structure beneath it. `--in-place` writes back over the original paths. It is never the default, because repeated in-place restores with `--conflict rename` create suffixed duplicates among live content. See [Where restored files land](/onedrive-backup#where-restored-files-land).

An owner can have several drives. Each manifest entry records the drive its file came from. A restore to the original owner returns each file to its drive. A file whose drive no longer exists is reported and skipped, never written to a different drive. `--target-owner` has no drive mapping, because Atlas records drive IDs and not drive names. It is refused when the snapshot spans more than one drive. Restore those to the original owner, or one drive at a time with `--file-filter`.

A `--file-filter` path is the rooted path shown in a listing. A file at the root is written as `/Report.docx`, not `//Report.docx`. Version commands accept the same path forms. When one path belongs to two drive items, which happens after a file is deleted and recreated at the same path, the command lists both file IDs and stops instead of choosing one.

**`atlas onedrive list-snapshots`**

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Override the tenant ID from config       |

**`atlas onedrive list-versions`**

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-f, --file <ref>`  | Graph file ID or drive path (required)   |
| `-t, --tenant <id>` | Override the tenant ID from config       |

**`atlas onedrive restore-version`**

Restores the version bytes Atlas holds. Use it to roll a file back past a bad edit, or a whole folder back past a mass encrypt-and-sync event.

| Option              | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required)                                  |
| `-f, --file <ref>`  | Graph file ID or drive path. Required with `--version`.                   |
| `--version <id>`    | Exact stored version, as shown in the `Version` column of `list-versions` |
| `--before <iso>`    | Restore each file's newest version at or before this instant              |
| `--path <prefix>`   | Limit a `--before` rollback to this folder and below                      |
| `--in-place`        | Upload over the original file instead of writing a copy beside it         |
| `-t, --tenant <id>` | Override the tenant ID from config                                        |

Use either `--file` with `--version`, or `--before`. `--version` alone is rejected, because a version ID is unique only within one file. `--path` cannot be combined with `--file`, since a folder scope and a single file are different requests.

::: warning Nothing is overwritten unless you ask
By default the restore writes a sibling such as `report (restored 2026-03-01T08-15-00Z).docx` and leaves the live file untouched, so you can inspect the rollback before adopting it. `--in-place` uploads over the original path. Even then the earlier content is kept, because Microsoft 365 records the upload as a new version and retains the replaced one in the file's version history.
:::

Restored files keep the modification time the version had, not the time of the restore. A rolled-back document does not look as though it was authored during the incident.

A file with no version at or before the cutoff is **reported, not skipped silently**, and counts toward the skipped total. Treat that list as the outstanding work, since those files have no pre-incident copy in the backup.

The exit code follows the same contract as snapshot `restore`: `0` when every file was rolled back, `2` when files were skipped, and `1` when any restore errored.

Microsoft Graph can promote an earlier version in place with `restoreVersion`, but Atlas does not use it. That call works only on versions the service still holds, so it fails when a backup is needed most: after a retention policy trims history, after a file is deleted, or after a library is removed. Atlas also cannot check that result against the manifest checksum. Atlas uploads the bytes it stored and verified, which guarantees the content matches what the backup recorded.

**`atlas onedrive save`**

Save decrypted files from a snapshot to a local zip archive that preserves the folder structure. Each file is SHA-256 verified after decryption unless `--skip-verify` is set. Atlas writes the archive to a temporary file beside the output path and moves it into place only when complete. A failed save leaves no partial archive, and an existing file at the output path is not touched until a successful run replaces it.

```bash
atlas onedrive save -o user@company.com -s od-snap-1735689600000-a1b2c3
atlas onedrive save -o user@company.com -s od-snap-123 --output ~/Downloads/backup.zip
atlas onedrive save -o user@company.com -s od-snap-123 --file-filter "/Documents/report.docx"
atlas onedrive save -o user@company.com -s od-snap-123 --skip-verify
```

| Option                     | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `-o, --owner <id>`         | User email or Entra object ID (required)       |
| `-s, --snapshot <id>`      | OneDrive snapshot ID (required)                |
| `--file-filter <paths...>` | Save only specific files, by ID or path        |
| `--output <path>`          | Output zip file path (default: auto-generated) |
| `--skip-verify`            | Skip SHA-256 integrity checks                  |
| `-t, --tenant <id>`        | Override the tenant ID from config             |

```
onedrive-od-snap-123-2026-05-24T14-30-00.zip
  Documents/
    report.docx
    budget.xlsx
  Photos/
    vacation.jpg
```

Files larger than 4 MiB are decrypted as a stream, so the full ciphertext is never held in memory.

**`atlas onedrive verify`**

| Option                | Description                              |
| --------------------- | ---------------------------------------- |
| `-o, --owner <id>`    | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | OneDrive snapshot ID (required)          |
| `-t, --tenant <id>`   | Override the tenant ID from config       |

Failed objects and storage errors are classified as in [`atlas outlook verify`](#atlas-outlook-verify).

**`atlas onedrive status`**

Reports pending Graph changes per drive by replaying the saved delta links from the latest manifest chain. It is read-only: no backup runs and nothing is written.

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Override the tenant ID from config       |

**`atlas onedrive delete`**

Deletes the owner's OneDrive backups behind the same confirmation prompt as the Outlook delete. Without `-s`, it removes the owner's `manifests`, `data`, `index`, `_meta`, and `staging` prefixes. The staging prefix is included so an interrupted large-file upload does not leave content behind in the bucket. With `-s`, only that snapshot's manifest is removed. The blobs stay, because other snapshots may reference them.

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `-o, --owner <id>`    | User email or Entra object ID (required)          |
| `-s, --snapshot <id>` | Delete only this snapshot instead of every backup |
| `-y, --yes`           | Skip the confirmation prompt                      |
| `-t, --tenant <id>`   | Override the tenant ID from config                |

::: tip Permissions
Backup and read operations need the application permissions `Files.Read.All` and `User.Read.All`. Restore also needs `Files.ReadWrite.All`. See the [OneDrive backup](/onedrive-backup) page for storage layout.
:::

## atlas sharepoint

Back up, restore, and verify SharePoint document library files per site, using Graph delta sync. Blobs and manifests live under the `sharepoint/` prefix of the tenant bucket. SharePoint backup targets a site, not a user. The site can be given as a URL or a Graph site ID (see [Identifiers](#identifiers)).

As with OneDrive, a snapshot is a delta. `restore`, `save`, and `verify` read the full manifest chain for the site, with the same tombstone and merge rules described under [`atlas onedrive`](#atlas-onedrive).

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --full
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering -f /Documents/report.docx
atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering -f /Documents/report.docx --version 3.0
atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering --before 2026-03-10T00:00:00Z
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --destination /DR-drill
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
atlas sharepoint status --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint delete --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint delete --site https://contoso.sharepoint.com/sites/Engineering -y
```

| Subcommand        | Description                                                                  |
| ----------------- | ---------------------------------------------------------------------------- |
| `backup`          | Incremental sync. Use `--full` to ignore saved delta state.                  |
| `list-snapshots`  | List all SharePoint snapshots for a site                                     |
| `list-versions`   | List all backed-up versions of one file                                      |
| `restore-version` | Push stored file versions back into the library, one file or a whole rollback |
| `restore`         | Restore files from a snapshot to the site's document libraries               |
| `save`            | Decrypt files from a snapshot into a local zip archive                       |
| `verify`          | Decrypt manifests and blobs for a snapshot, and check SHA-256 and index rows |
| `status`          | Report pending Graph changes per document library, without backing up        |
| `delete`          | Delete the site's SharePoint backups, or one snapshot                        |

**`atlas sharepoint backup`**

| Option                 | Description                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `--site <url-or-id>`   | SharePoint site URL or Graph site ID (required)                                             |
| `--full`               | Force a full crawl, ignoring saved delta links                                              |
| `--include-subsites`   | Also back up every subsite beneath the site, one snapshot per subsite                       |
| `--retention-days <n>` | Apply Object Lock **default retention** for `n` days (same semantics as OneDrive)           |
| `--lock-mode <mode>`   | Object Lock mode, `governance` or `compliance` (default `governance`). Requires `--retention-days`. |
| `-t, --tenant <id>`    | Override the tenant ID from config                                                          |

::: tip Subsites are separate sites
Graph's `GET /sites/{site-id}/sites` returns only a site's direct subsites, so Atlas walks the tree explicitly. By default a backup covers only the named site and warns once for each subsite it does not cover. Classic site collections with nested subsites would otherwise look fully protected while whole subsites sat outside the backup.

`--include-subsites` backs up the whole tree. Each subsite has its own drives, so it gets its own snapshot under its own `site_id` prefix (`sharepoint/manifests/{site_id}/...`). It has the same structure as a root-site backup, so you restore a subsite by naming it. Graph returns only the subsites the application can read. A subsite that cannot be enumerated is reported as a warning, not treated as absent, so an access gap never narrows the scope silently. Traversal stops at 20 levels.
:::

**`atlas sharepoint list-snapshots`**

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>`  | Override the tenant ID from config              |

**`atlas sharepoint list-versions`**

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-f, --file <ref>`   | File ID or path (required)                      |
| `-t, --tenant <id>`  | Override the tenant ID from config              |

**`atlas sharepoint restore-version`**

| Option               | Description                                                       |
| -------------------- | ----------------------------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required)                   |
| `-f, --file <ref>`   | File ID or path. Required with `--version`.                       |
| `--version <id>`     | Exact stored version, as shown by `list-versions`                 |
| `--before <iso>`     | Restore each file's newest version at or before this instant      |
| `--path <prefix>`    | Limit a `--before` rollback to this folder and below              |
| `--in-place`         | Upload over the original file instead of writing a copy beside it |
| `-t, --tenant <id>`  | Override the tenant ID from config                                |

Semantics match [`atlas onedrive restore-version`](#atlas-onedrive), including copy-by-default placement and the upload of stored bytes in place of Graph's `restoreVersion`. Versions go back into the library they were captured from.

**`atlas sharepoint restore`**

| Option                      | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `--site <url-or-id>`        | SharePoint site URL or Graph site ID (required)                                 |
| `-s, --snapshot <id>`       | SharePoint snapshot ID (required)                                               |
| `--target-site <url-or-id>` | Restore to a different site (defaults to the original)                          |
| `--destination <path>`      | Folder to restore under, created if missing (default: `/Restore-<timestamp>`)   |
| `--in-place`                | Restore to the original paths instead of a restore root                         |
| `--name <filename>`         | Rename the restored file. Rejected unless exactly one file matches.             |
| `--file-filter <paths...>`  | Restore only specific files, by ID or path                                      |
| `-c, --conflict <mode>`     | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`)        |
| `-t, --tenant <id>`         | Override the tenant ID from config                                              |

Restored files nest under `Restore-<timestamp>` in each destination library, with the original structure beneath it. `--in-place` writes over the original paths, as earlier releases did. See [Where restored files land](../sharepoint-backup.md#where-restored-files-land).

With `--target-site`, each file goes to the target library with the same name as its source library. If the restore comes from a single library, it goes to the target's only library. Any ambiguous case is refused. The file is skipped, the candidate libraries are listed, and the command exits non-zero. Atlas never writes into the source library instead. See [Where a cross-site restore lands](../sharepoint-backup.md#where-a-cross-site-restore-lands).

**`atlas sharepoint save`**

Save decrypted files from a SharePoint snapshot to a local zip archive that preserves the library folder structure. Each file is SHA-256 verified after decryption unless `--skip-verify` is set.

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --output ~/Downloads/backup.zip
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --file-filter "/Documents/report.docx"
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --skip-verify
```

| Option                     | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `--site <url-or-id>`       | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>`      | SharePoint snapshot ID (required)               |
| `--file-filter <paths...>` | Save only specific files, by ID or path         |
| `--output <path>`          | Output zip file path (default: auto-generated)  |
| `--skip-verify`            | Skip SHA-256 integrity checks                   |
| `-t, --tenant <id>`        | Override the tenant ID from config              |

**`atlas sharepoint verify`**

| Option                | Description                                     |
| --------------------- | ----------------------------------------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>` | SharePoint snapshot ID (required)               |
| `-t, --tenant <id>`   | Override the tenant ID from config              |

Failed objects and storage errors are classified as in [`atlas outlook verify`](#atlas-outlook-verify).

**`atlas sharepoint status`**

Reports pending Graph changes per document library from the saved delta links. Read-only.

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>`  | Override the tenant ID from config              |

**`atlas sharepoint delete`**

Deletes the site's SharePoint backups behind a confirmation prompt. Without `-s`, it removes the site's `manifests`, `data`, `index`, `_meta`, and `staging` prefixes. With `-s`, only that snapshot's manifest is removed, and the shared blobs stay.

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID (required)   |
| `-s, --snapshot <id>` | Delete only this snapshot instead of every backup |
| `-y, --yes`           | Skip the confirmation prompt                      |
| `-t, --tenant <id>`   | Override the tenant ID from config                |

::: tip Permissions
Backup and verification need the application permissions `Sites.Read.All` and `Files.Read.All`. Restore also needs `Sites.ReadWrite.All`.
:::

## atlas storage-check

Check whether the bucket can hold immutable backups, without running a backup. The command reports versioning, Object Lock status, and the bucket class:

- `lock-capable`: can take retention policies.
- `versioned-only (legacy)`: predates v2.1.0 auto-provisioning.
- `unversioned (legacy)`: predates v2.1.0 auto-provisioning.

Legacy buckets need the [migration runbook](/self-hosting/storage#migrating-a-legacy-bucket) before immutability can be used. The command exits non-zero when the bucket is not ready, so it can gate scheduled jobs.

```bash
atlas storage-check
atlas storage-check --lock-mode governance --retention-days 30
atlas storage-check --lock-mode compliance --retention-days 365
```

| Option                 | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `--lock-mode <mode>`   | Planned Object Lock mode (`governance` or `compliance`) |
| `--retention-days <n>` | Planned retention period in days                        |
| `-t, --tenant <id>`    | Override the tenant ID from config                      |

## atlas stats

Storage statistics across the backed-up services. By default the command covers Outlook, OneDrive, and SharePoint in one pass. For each service it reports snapshot counts, item counts (messages or files), encrypted storage size, and a monthly breakdown.

The statistics come from the encrypted snapshot manifests in the bucket. The only Graph call happens when `-m`, `-o`, or `--site` is given as an address or URL. Pass an object ID or a site ID to make no Graph call. With `--json`, log lines from identity resolution go to stderr, so stdout carries only the JSON.

```bash
atlas stats                            # all services
atlas stats --service outlook          # Outlook bucket-level overview only
atlas stats -m user@company.com        # Outlook mailbox-level breakdown
atlas stats -o user@company.com        # OneDrive statistics for one owner
atlas stats --site https://contoso.sharepoint.com/sites/Engineering   # one site
atlas stats --top 5                    # limit owner and site tables to 5 rows
atlas stats --json                     # raw JSON output
```

| Option                        | Description                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `-m, --mailbox <email-or-id>` | Outlook statistics for one mailbox (implies `--service outlook`)                           |
| `-o, --owner <email\|id>`     | OneDrive statistics for one owner (implies `--service onedrive`)                           |
| `--site <url\|id>`            | SharePoint statistics for one site (implies `--service sharepoint`)                        |
| `--service <name>`            | Limit output to `outlook`, `onedrive`, `sharepoint`, or `all` (default `all`)              |
| `--top <n>`                   | Maximum owner or site rows in the OneDrive and SharePoint tables (default 20)              |
| `--json`                      | Output raw JSON instead of formatted tables                                                |
| `-t, --tenant <id>`           | Override the tenant ID from config                                                         |

Use only one of `--mailbox`, `--owner`, or `--site` at a time. Each one scopes the output to its service. The OneDrive and SharePoint sections list per-owner and per-site rollups (snapshots, files, size, last backup time), sorted by size, so the largest consumers appear first. `--owner` accepts an email, which Graph resolves to an object ID, or a raw object ID. `--site` accepts a site URL or a composite site ID.

With several services, `--json` returns an object keyed by service name. With one service, it returns that service's stats object.

### atlas stats storage

Measure the bytes that the tenant bucket, or a replica of it, physically holds, by listing it. `atlas stats` reports logical sizes from the manifests. `atlas stats storage` reports what the bucket stores and a provider bills: current and noncurrent versions, delete markers, staging objects, and incomplete multipart uploads. It breaks these down per workload, and optionally per owner. See [Storage usage](/operations/storage-usage) for what each figure means and what a run costs in list requests.

```bash
atlas stats storage                                   # the tenant bucket, per workload
atlas stats storage --by owner --top 10               # the ten largest owners and sites
atlas stats storage --target-config replica.json      # a replica
atlas stats storage --max-requests 1000 --json        # stop after 1,000 requests, print a token
atlas stats storage --continue <token> --json         # resume from that token
```

| Option                      | Description                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `--by <breakdown>`          | `workload` (default) or `owner`, which adds one row per mailbox, OneDrive owner, or site |
| `--target-endpoint <url>`   | Measure a replica at this S3 endpoint instead of the primary storage                     |
| `--target-access-key <key>` | Replica S3 access key                                                                    |
| `--target-secret-key <key>` | Replica S3 secret key. `-` reads it from stdin.                                          |
| `--target-region <region>`  | Replica S3 region                                                                        |
| `--target-config <path>`    | JSON file with replica credentials, in the format `atlas replicate` uses                 |
| `--max-requests <n>`        | Stop after this many S3 requests and print a continuation token                          |
| `--continue <token>`        | Resume a measurement from its continuation token                                         |
| `--top <n>`                 | Maximum owner rows with `--by owner` (default 20)                                        |
| `--json`                    | Output raw JSON instead of formatted tables                                              |
| `-t, --tenant <id>`         | Override the tenant ID from config                                                       |

The JSON output includes `totals`, `by_workload`, `stored_bytes`, `list_requests`, and `complete`. It includes `by_owner` with `--by owner`, and `logical_bytes_referenced` on a complete run with readable manifests. If the credentials cannot list versions, multipart uploads, or their parts, the report says so in `versions_visible` and `incomplete_uploads_visible`. The affected columns show `n/a`, and the stored totals become a lower bound.

A run that fails on an S3 error prints a continuation token to stderr, so the next run resumes where this one stopped. Any `--target-*` flag selects a replica. A replica flag without `--target-endpoint` or `--target-config` is refused, so the command never measures primary storage by mistake. The command is read-only. It creates no bucket and no key material. A replica without the tenant bucket fails with `NoSuchBucket`. `--top` and `--json` are shared with `atlas stats` and can appear before or after `storage`.

## atlas list-users

List the users recorded in the identity registry, which backups populate. The output has two tables, one for active users and one for recycled users. Each lists Email, Object ID, Display Name, and Since.

```bash
atlas list-users
atlas list-users -t <tenant-id>
```

| Option              | Description                        |
| ------------------- | ---------------------------------- |
| `-t, --tenant <id>` | Override the tenant ID from config |

When the registry is empty, the command prints `No users registered yet. Run a backup to populate the registry.`

## atlas keys

Manage the tenant data key. The only verb is `rewrap`.

```bash
atlas keys rewrap                       # re-wrap under the configured passphrase, current KDF parameters
atlas keys rewrap --new-passphrase      # prompt for a new passphrase, twice, with no echo
atlas keys rewrap --new-passphrase < secret.txt   # non-interactive, for a scripted rotation
```

| Subcommand    | Description                                                                     |
| ------------- | ------------------------------------------------------------------------------- |
| `keys rewrap` | Re-wrap `_meta/dek.enc` under a new passphrase, current KDF parameters, or both |

| Option              | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| `--new-passphrase`  | Prompt for a new passphrase. Omit it to re-wrap under the configured one. |
| `-t, --tenant <id>` | Override the tenant ID from config                                    |

The data key does not change. Nothing in the bucket is re-encrypted, every snapshot stays readable, and the run writes one object. What changes is the wrapper. The key-encryption key (KEK) is derived again from the new passphrase and a fresh salt, under the current KDF parameters. A tenant set up with weaker scrypt parameters is brought up to date by running the command with no flags.

::: danger This rotates the wrapper, not the data key
Re-wrapping answers a **leaked passphrase**. It does not answer a compromised bucket. If the data key or the plaintext has already been captured, a new passphrase does not help, because the attacker no longer needs the passphrase. Replication does not help either, since it copies ciphertext under the same key. A compromised data key requires a new bucket and a fresh backup. See [Rotating the data key](/security#rotating-the-data-key).
:::

::: warning The old passphrase stays valid until the replaced version expires
Atlas buckets are versioned, and noncurrent versions expire after 30 days. A re-wrap writes a new current `_meta/dek.enc` and keeps the version it replaced. Anyone holding the old passphrase, with permission to read object versions, can still unwrap the same unchanged data key from that version until it expires. Delete the noncurrent versions of `_meta/dek.enc` where policy and Object Lock allow. Alternatively, revoke the leaked reader's `s3:GetObjectVersion` permission, which closes the window immediately.
:::

The new passphrase is prompted for and confirmed, not accepted as a flag value. That keeps it out of shell history and the process table. When input is piped, the passphrase is read from stdin in full, with no confirmation step.

The order is deliberate. Atlas first unwraps the stored key with the current passphrase, so a wrong passphrase fails before anything is written. After the write, it reads the blob back and unwraps it with the new passphrase. The run reports success only when the key that comes back matches the key that went in. A wrapper that cannot be unwrapped would make the bucket unreadable, and finding that out at the next backup is too late. Keep both passphrases until a read succeeds with the new one.

After the command succeeds, update `ATLAS_ENCRYPTION_PASSPHRASE` or run `atlas config set encryption.passphrase`. Nothing reads the new value until you do.

If `_meta/dek.enc` is under an Object Lock retention policy, the write is refused until retention expires. The command reports that the stored key is unchanged, rather than returning a bare access denial that looks like a credentials fault.

## atlas config

Manage Atlas configuration in an encrypted local store. Values are written to `~/.atlas/config.enc` (AES-256-GCM). The store key lives in the OS keyring (macOS Keychain or libsecret), so credentials are never stored in plaintext on disk. See [Configuration](../configuration.md) for precedence and [Security](../security.md) for the threat model.

```bash
atlas config set tenant.id 4fa2a706-b26a-4bbe-9b1c-1e671b586b8f   # set and validate
pbpaste | atlas config set client.secret -                        # "-" reads from stdin, keeping it out of shell history
atlas config get client.secret                                    # secrets are masked
atlas config list                                                 # all keys, values, and sources
atlas config unset client.secret                                  # remove from the store
atlas config validate                                             # live Graph and S3 connectivity check
```

| Subcommand                 | Description                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `config set <key> <value>` | Validate and save a value to the encrypted store. `-` reads the value from stdin.                                 |
| `config get <key>`         | Print the effective value. Secrets are masked.                                                                    |
| `config list`              | Print every key with its value and source (`env`, `secure store`, or `config file`)                               |
| `config unset <key>`       | Remove a key from the encrypted store                                                                             |
| `config validate`          | Probe Microsoft Graph (token request) and S3 (`ListBuckets`) with the effective config. Exits non-zero on failure. |

Each verb is a subcommand, so `atlas config set --help` documents itself.

| Key                   | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `tenant.id`           | Microsoft Entra tenant. A GUID or an `*.onmicrosoft.com` domain.            |
| `client.id`           | Entra app registration (client) ID. Must be a GUID.                         |
| `client.secret`       | Client secret. Masked.                                                      |
| `s3.endpoint`         | S3 endpoint URL. Must use `http` or `https`.                                |
| `s3.access-key`       | S3 access key                                                               |
| `s3.secret-key`       | S3 secret key. Masked.                                                      |
| `s3.region`           | S3 region. Lowercase letters, digits, and dashes. Default `us-east-1`.      |
| `encryption.passphrase` | Tenant encryption passphrase. Masked. At least 14 UTF-8 bytes.            |

Each value is format-checked on save. When a credential group is complete, its live probe runs automatically. `ATLAS_*` environment variables still override stored values. The command warns when a saved value is shadowed by one.

## atlas replicate

Replicate snapshots to a secondary S3-compatible target. Ciphertext is copied as-is, with no decryption. Only unreplicated snapshots and missing objects are transferred. To report progress, use the `status` subcommand. It takes the same scope flags and writes no data.

```bash
atlas replicate -s <snapshot-id> \
  --target-endpoint http://offsite:9000 \
  --target-access-key <key> \
  --target-secret-key <secret>

atlas replicate -m user@company.com --target-config ./offsite.json

atlas replicate --site https://contoso.sharepoint.com/sites/Engineering --target-config ./offsite.json
atlas replicate --site contoso.sharepoint.com,guid,guid -s sp-snap-1735689600000-a1b2c3 --target-config ./offsite.json

atlas replicate -o user@company.com --target-config ./offsite.json
atlas replicate -o user@company.com -s od-snap-1735689600000-a1b2c3 --target-config ./offsite.json

atlas replicate status
atlas replicate status -m user@company.com
atlas replicate status -s <snapshot-id>
atlas replicate status --site https://contoso.sharepoint.com/sites/Engineering
atlas replicate status -o user@company.com
```

| Option                        | Description                                                |
| ----------------------------- | ---------------------------------------------------------- |
| `-s, --snapshot <id>`         | Replicate a specific snapshot, any workload                |
| `-m, --mailbox <email-or-id>` | Replicate all unreplicated snapshots for a mailbox         |
| `--site <url-or-id>`          | Replicate all unreplicated snapshots for a SharePoint site |
| `-o, --owner <email-or-id>`   | Replicate all unreplicated snapshots for a OneDrive owner  |
| `--target-endpoint <url>`     | Target S3 endpoint URL                                     |
| `--target-access-key <key>`   | Target S3 access key                                       |
| `--target-secret-key <key>`   | Target S3 secret key. `-` reads it from stdin.             |
| `--target-region <region>`    | Target S3 region (default: `us-east-1`)                    |
| `--target-config <path>`      | JSON file with the target S3 credentials                   |
| `-t, --tenant <id>`           | Override the tenant ID from config                         |

`replicate status` accepts the same scope flags (`-s`, `-m`, `--site`, `-o`) and reports replication state without copying anything.

::: tip Target config file
The target config is a JSON object with `s3_endpoint`, `s3_access_key`, and `s3_secret_key`. It can also include `s3_region` and `target_id`. The encryption passphrase comes from the main Atlas configuration, so it is not stored in this file.
:::

Pass the secret key with `-` to keep it out of shell history and the process table. An inline secret is written to history, and any local user can read it from the process list while the command runs. That is a long window on a large tenant:

```bash
atlas replicate -m user@company.com \
  --target-endpoint http://offsite:9000 \
  --target-access-key <key> \
  --target-secret-key - < target-secret.txt
```

Trailing whitespace and the trailing newline are trimmed. If stdin is empty or unreadable, the command fails and names the option, rather than authenticating with an empty secret. Only the secret key accepts `-`, because the access key ID is not secret and only one option per invocation can read stdin. `--target-config` also works, but you must manage that file's permissions yourself. `-` is preferable when the secret comes from a secret manager or a pipe.

## atlas rehydrate

Recover snapshots from a replica to primary storage. This is a disaster recovery operation, not a bidirectional sync. Snapshots already on primary are skipped.

```bash
atlas rehydrate -s <snapshot-id> \
  --source-endpoint http://offsite:9000 \
  --source-access-key <key> \
  --source-secret-key <secret>

atlas rehydrate -m user@company.com --source-config ./offsite.json
atlas rehydrate --all --source-config ./offsite.json

atlas rehydrate --site https://contoso.sharepoint.com/sites/Engineering --source-config ./offsite.json
atlas rehydrate --site contoso.sharepoint.com,guid,guid -s sp-snap-1735689600000-a1b2c3 --source-config ./offsite.json

atlas rehydrate -o user@company.com --source-config ./offsite.json
atlas rehydrate -o user@company.com -s od-snap-1735689600000-a1b2c3 --source-config ./offsite.json
```

| Option                        | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `-s, --snapshot <id>`         | Recover a specific snapshot from the replica                 |
| `-m, --mailbox <email-or-id>` | Recover all snapshots for a mailbox from the replica         |
| `--site <url-or-id>`          | Recover all SharePoint snapshots for a site from the replica |
| `-o, --owner <email-or-id>`   | Recover all OneDrive snapshots for an owner from the replica |
| `--all`                       | Recover every workload: Outlook, OneDrive, and SharePoint    |
| `--source-endpoint <url>`     | Source replica S3 endpoint URL                               |
| `--source-access-key <key>`   | Source replica S3 access key                                 |
| `--source-secret-key <key>`   | Source replica S3 secret key. `-` reads it from stdin.       |
| `--source-region <region>`    | Source replica S3 region (default: `us-east-1`)              |
| `--source-config <path>`      | JSON file with the source S3 credentials                     |
| `-t, --tenant <id>`           | Override the tenant ID from config                           |

Scopes are matched in this order: `--site`, `-o`/`--owner`, `-s`/`--snapshot`, `-m`/`--mailbox`, `--all`. `-s` works for all three workloads. The snapshot ID shows which workload it belongs to (`od-snap-*` for OneDrive, `sp-snap-*` for SharePoint, `snap-*` for Outlook). Atlas resolves the owner or site from storage, so you do not need to name it again. Combining `--site` or `-o` with `-s` addresses the same single snapshot explicitly.

`-o` and `-m` accept an email or a raw Entra object ID. Recovery resolves an email through Microsoft Graph only. Unlike the `atlas onedrive` and `atlas outlook` commands, it does not write the resolved identity back to primary. That write would create a fresh encryption key in the target bucket and block the replica's key from being copied (see the encryption key warning at the end of this section). Pass the object ID directly when Graph is unreachable or the user has been deleted from the directory.

Pass the secret with `-` so it never reaches shell history or the process table. Stdin rules match [`atlas replicate`](#atlas-replicate): trailing whitespace is trimmed, and empty or unreadable stdin fails with the option named.

```bash
atlas rehydrate --all \
  --source-endpoint http://offsite:9000 \
  --source-access-key <key> \
  --source-secret-key - < source-secret.txt
```

`--all` recovers all three workloads: every Outlook mailbox (`manifests/`), every OneDrive owner (`onedrive/manifests/`), and every SharePoint site (`sharepoint/manifests/`) on the replica. The summary breaks the run down by workload, so a partial recovery is visible:

```
Workload    Scope        Copied  Skipped  Failed  Size
outlook     2-snapshots  35      0        0       433.3 KB
onedrive    1-owners     12      1        0       2.7 MB
sharepoint  1-sites      59      0        0       7.1 MB
```

A workload with no objects prints a warning that names it, because the replica held nothing for that workload. Check that against the source before you treat a drill as passed.

::: danger Rehydration is not sync
Rehydration copies the data you select from a designated replica to primary. It does not merge, diff, or resolve conflicts. After rehydration, primary is the source of truth again. Delta links in recovered manifests can be stale, so the next backup falls back to a full sync automatically.
:::

::: warning Encryption key safety
Rehydration needs the replica's encryption key (`_meta/dek.enc`) on primary. Atlas copies it when primary has no key. It replaces an existing key only when that key is provably the only object in primary (a freshly initialized bucket). If primary holds **any** other object, such as Outlook, OneDrive, or SharePoint data or replication records, and its key differs from the source, rehydration aborts with `DekOverwriteRefusedError`. Overwriting would make that data permanently unreadable. If primary's content is disposable, run `atlas delete --purge` first, then rehydrate into the empty bucket.
:::
