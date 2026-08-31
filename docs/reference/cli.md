# CLI Commands

Complete reference for every Atlas CLI command.

Atlas ships as **`@wisecom/atlas-cli`**. Install globally for shell-based operations:

```bash
npm install -g @wisecom/atlas-cli
```

The CLI reads credentials from `.env` and environment variables (see [Configuration](/configuration)). It is the right choice for cron jobs, operator workflows, and simple deployments where you run commands directly.

With a **local** (non-global) install, a postinstall hook links `atlas` into `/usr/local/bin` or `~/.local/bin` so the command works system-wide. The hook is conservative: if `atlas` is already a shell alias or an existing command on PATH, it skips with a warning and leaves your setup untouched (use `npx atlas` in that case). It never fails the install. Opt out with `ATLAS_SKIP_POSTINSTALL=1`; re-run manually with `npm run link-cli --prefix node_modules/@wisecom/atlas-cli`. Note: pnpm blocks dependency lifecycle scripts by default, so run `pnpm approve-builds` to allow it. Windows relies on npm's own `.cmd` shims (global install).

For programmatic use in Node.js applications (custom schedulers, multi-tenant SaaS, portals), use **`@wisecom/atlas-sdk`** instead. See [Programmatic SDK](/reference/sdk). The SDK uses explicit config at construction time (no `.env` dependency) and exposes the same operations as typed methods.

## Output width

Tables and dashboards are laid out for the terminal width. When output is piped or redirected there is no terminal to measure, so Atlas falls back to 80 columns and long cells such as site URLs and object ids wrap onto a second line. Set `COLUMNS` to keep each row intact:

```bash
COLUMNS=200 atlas sharepoint list-sites > sites.txt
```

This matters beyond readability. Anything that post-processes the output, a log scrubber, a grep for an id, a parser, sees a wrapped value as two unrelated fragments and misses it.

## `atlas outlook`

Outlook mailbox backup, restore, and management commands. All mailbox operations live under this group; cross-cutting storage and replication commands remain at the root level.

::: warning Scope flags: `-s` beats `-m`
`restore`, `list` and `save` all select what to act on with `-s, --snapshot` (one snapshot) or `-m, --mailbox` (every snapshot for a mailbox). When both are passed, `-s` wins, matching `atlas replicate`. A snapshot id names exactly one thing, so it is the narrower request, and Atlas never silently widens it.

`list` and `save` warn that `-m` was ignored and carry on. `restore` refuses the pair outright and exits `1`, because `-m` there used to mean "restore this snapshot into that mailbox instead", so guessing would decide which mailbox receives the mail. Use `-T, --target` for that, which works in both modes:

```bash
atlas outlook restore -s <snapshot-id> -T other@company.com
```

`-T` never selects what to restore, only where it lands.
:::

### `atlas outlook backup`

Back up one mailbox from an M365 tenant to object storage, with a per-folder progress dashboard. The `-m` flag is required. To back up multiple mailboxes, enumerate them with `atlas outlook mailboxes` and loop in your scheduler (cron, systemd timer, CI); fan-out across mailboxes is scheduling and belongs to the caller.

```bash
atlas outlook backup -m user@company.com                      # incremental backup
atlas outlook backup -m user@company.com --full                # force full sync (ignore delta state)
atlas outlook backup -m user@company.com -f Inbox Sent         # specific folders only
atlas outlook backup -m user@company.com -P 50                 # larger page size for fewer API round-trips
atlas outlook backup -m user@company.com --retention-days 30 --lock-mode governance
atlas outlook backup -m user@company.com --retention-days 365 --lock-mode compliance
atlas outlook backup -t <tenant-id> -m user@company.com        # explicit tenant
```

| Option                   | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `-m, --mailbox <id>`     | Mailbox to back up (required)                                             |
| `-f, --folder <name...>` | Filter to specific folder(s) by name or path (see below)                  |
| `--full`                 | Ignore saved delta links, run full enumeration                            |
| `-P, --page-size <n>`    | Graph API page size per delta request (1--100, default 10)                |
| `--retention-days <n>`   | Apply Object Lock retention for `n` days                                  |
| `--lock-mode <mode>`     | Object Lock mode (`governance` or `compliance`); requires `--retention-days` |
| `-t, --tenant <id>`      | Override tenant ID from config                                            |
| `--exclude-junk`         | Skip the Junk Email folder and its subfolders                             |
| `--include-recoverable-items` | Also back up hard-deleted and hold-retained mail (see below)          |

`--lock-mode` only means something alongside `--retention-days`: the mode selects how retention is enforced, it does not request retention on its own. Passing it alone is rejected rather than ignored, so a run that was meant to be immutable cannot exit `0` with unprotected data. Retention without a mode defaults to `governance`.

Requesting retention is fail-closed: when the bucket has versioning or Object Lock disabled, or cannot honour the requested mode, the run aborts instead of writing unprotected data.

#### Which folders are backed up

Every mail folder in the mailbox, at any nesting depth, including the ones Outlook treats as special:

| Folder | Backed up | Note |
| ------------------------------ | -------------- | ------------------------------------------------------------------------ |
| Inbox, Sent Items, Deleted Items, Archive, and user folders | Yes | Including nested subfolders at any depth |
| **Drafts** and **Outbox** | Yes | Unsent work exists nowhere else, so it is content like any other |
| **Junk Email** | Yes | Opt out with `--exclude-junk`. Junk is evidence in a phishing or BEC case |
| Hidden folders (`isHidden`) | Yes | Enumerated explicitly; Graph omits them unless asked |
| Hidden Exchange system folders | No | A short deny-list of client-state folders such as `Conversation Action Settings`, matched only when Exchange also reports them hidden |
| In-Place Archive mailbox | No | Graph cannot read it at all. See [In-Place Archive is out of scope](../security.md#in-place-archive-is-out-of-scope) |
| **Recoverable Items** | Opt-in | `--include-recoverable-items`. Hard-deleted and hold-retained mail; see below |

Anything skipped is reported at the end of the run and recorded in the snapshot manifest with its reason, so "was folder X captured?" is answerable from the backup rather than from whoever ran it:

```
[!] 1 folder(s) not backed up:
      Junk Email (skipped by --exclude-junk)
```

::: warning Drafts and Outbox are new in 4.1.0
Earlier versions silently skipped Drafts and Outbox. New snapshots include them, which makes the first backup after upgrading larger than the previous one for mailboxes that hold unsent mail. Existing snapshots are unaffected; the content appears as those folders sync for the first time.
:::


#### Recoverable Items, the Exchange dumpster

A message that arrives and is hard-deleted between two backups never appears in
any delta page, so Atlas never sees it. The tenant's only copy is in the
Recoverable Items subtree, which an ordinary backup does not read: it is not a
child of the mailbox root Graph enumerates. Once Exchange's retention window
expires the item is gone from the tenant and from every snapshot.

```bash
atlas outlook backup -m user@company.com --include-recoverable-items
```

| Subfolder | Backed up | Contains |
| ------------------ | --------- | ------------------------------------------------------------- |
| `Deletions` | Yes | Items removed from Deleted Items, user-recoverable for 14 to 30 days |
| `Purges` | Yes | Hard-deleted items retained only by litigation hold or single item recovery |
| `DiscoveryHolds` | Yes | Hard-deleted items retained by an In-Place Hold or retention policy |
| `SubstrateHolds` | Yes | Original copies of held Teams messages and modified held items |
| `Versions` | No | Pre-modification copies whose item shape is not a message |
| `Calendar Logging` | No | Calendar change audit trail |
| `Audits` | No | Mailbox audit log entries |

Everything not captured is reported at the end of the run with its reason, and a
subfolder Atlas does not recognise is reported rather than guessed at, so a new
Exchange subfolder produces a visible gap instead of a silent one.

Off by default on purpose. On a mailbox under litigation hold the dumpster can
rival the mailbox in size, and that cost should be a decision. With the flag off
the request volume is identical to a run before this existed: locating the
subtree costs one request, and it is only spent when the flag is set.

::: warning Restoring purged mail is opt-in twice
Entries captured this way are marked in the manifest, and `restore` and `save`
**exclude them by default**. An ordinary restore must not resurrect mail
somebody deleted, or mail that exists only because a hold retained it. Pass
`--include-recoverable-items` to the restore or save command as well, including
when naming a single message with `--message`.

There is no path back into Recoverable Items itself: Graph offers none.
Recovered items land in the normal restore folder, which is what recovering a
deleted message means in practice.
:::

Storing purged mail has compliance consequences. See
[Recoverable Items and legal hold](../security.md#recoverable-items-and-legal-hold).

::: warning Exit codes (all backup commands: Outlook, OneDrive, SharePoint)
`0`: complete, every folder/file/mailbox processed without error. `1`: hard failure, the run aborted (auth, storage, unhandled error). `2`: **partial**, a snapshot was saved but the run is incomplete because of per-folder/per-file errors or a soft interrupt (Ctrl+C). Failed items are listed on stderr. Schedulers should treat `1` as "page me" and `2` as "warn me": a partial backup is restorable but is missing the listed items. A run is reported complete only when every error bucket is empty (corso's fault-model contract).

`restore` and `save` follow the same contract: a file they could not decrypt or write is counted as skipped, and any skipped file exits `2`. An export that produced an archive missing some of its files is not a success, and a cron job that only checks for `0` has to be able to see the difference.

An **integrity failure** exits `2` as well. A message whose decrypted bytes do not match the checksum its manifest records is still written to the archive, but it is no longer known to be the content that was backed up, so the export is not a clean success. It is counted and reported separately from other per-item errors because the cause is different: the ciphertext decrypted correctly and the stored checksum disagrees with the result, which points at the manifest or at the object having been replaced rather than at a transport fault. Use `atlas outlook verify` to establish the scope before trusting the archive. Interrupting a `save` or `restore` with Ctrl+C also exits `2`, on the same reasoning as an interrupted backup.
:::
::: details Page size tuning
The `--page-size` flag controls how many messages are requested per Graph API delta page via the `Prefer: odata.maxpagesize` header. This is a _hint_: the server may return fewer items when response payloads are large (e.g. messages with heavy HTML bodies or many inline images). Lower values reduce memory pressure and allow partial progress to be saved more frequently during interrupts. Higher values reduce HTTP round-trips but increase per-page processing time. The default of 10 is a conservative starting point; increase if you have many small messages and want fewer round-trips.
:::

:::: tip Nested folders and `--folder` matching
Atlas walks the whole mail-folder hierarchy, not just the folders directly under the mailbox root: `GET /users/{id}/mailFolders` returns only top-level folders, so every folder reporting child folders is expanded through `/childFolders` until the tree is exhausted. Folders are identified by their root-relative path (`Inbox/Projects/2026`), which is what `status`, backup progress, and `save` archive directories display.

A `--folder` selector matches either a full path (`Inbox/Projects`) or a bare folder name at any depth (`Projects`), case-insensitively, and always includes everything nested beneath the match. `--folder Inbox` backs up `Inbox`, `Inbox/Projects`, and `Inbox/Projects/2026`. Use the full path when the same folder name exists under several parents. Excluded system folders (Drafts, Outbox, recoverable items) are pruned together with their subtrees.

Recursion is bounded at 300 levels, matching Exchange's own folder-depth limit; anything deeper is skipped with a warning rather than recursed forever.
::::

::: details Immutability behavior
`--retention-days` makes the backup immutable-requested. Atlas resolves retention to an internal UTC `retain_until`, probes bucket capability (versioning + Object Lock), and fails fast when unsupported instead of silently downgrading to mutable writes.
:::

### `atlas outlook verify`

Verify the full restorable state of a backup snapshot. Resolves the snapshot's merged manifest chain (delta manifests are not self-contained, so verification walks the same merged view a restore would draw from), then checks **every referenced object, message bodies and attachments**: each is downloaded, decrypted (which validates the AES-256-GCM authentication tag against tampering), re-hashed with SHA-256, and compared against the manifest checksum using constant-time comparison (`timingSafeEqual`).

```bash
atlas outlook verify -m user@company.com -s <snapshot-id>
atlas outlook verify -m user@company.com -s <snapshot-id> -t <tenant-id>
atlas outlook verify -m user@company.com -s <snapshot-id> --fast
```

| Option                  | Description                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `-m, --mailbox <email>` | Mailbox that owns the snapshot (required)                                                   |
| `-s, --snapshot <id>`   | Snapshot identifier to verify (required)                                                    |
| `-t, --tenant <id>`     | Override tenant ID from config                                                              |
| `--fast`                | Existence-only checks (`HeadObject` per referenced key), with no download, decrypt, or hashing |

::: details What exactly is verified?
Verification covers the **merged entry set of the snapshot's manifest chain**: the target delta manifest plus every older manifest of the same mailbox, deduplicated newest-first. It is the same routine restore uses, so the two views cannot drift. A corrupt or missing object from an _older_ backup run fails verification of every later snapshot that still references it.

Both message blobs and `attachments` are checked (storage key + checksum). Entries with no stored blob at all (e.g. large attachments skipped by pre-v2.1.0 backups) are reported as **unverifiable** and fail the run with a non-zero exit code, because they represent content a restore cannot reproduce.

`--fast` trades depth for cost: it only confirms every referenced object exists in the bucket, which catches the most common real-world damage (lifecycle deletion, failed replication, manual cleanup) at near-zero bandwidth. Scheduled deep verification should use full mode, which also validates ciphertext integrity via the GCM authentication tag.
:::

### `atlas outlook restore`

Restore emails from backup to an M365 mailbox.

**Snapshot mode**, restore from a specific snapshot:

```bash
atlas outlook restore -s <snapshot-id>
atlas outlook restore -s <snapshot-id> -f Inbox
atlas outlook restore -s <snapshot-id> --message 42
atlas outlook restore -s <snapshot-id> -m target@company.com
```

**Mailbox mode**, aggregate all snapshots for a mailbox, deduplicate, and restore:

```bash
atlas outlook restore -m user@company.com
atlas outlook restore -m user@company.com -f Inbox
atlas outlook restore -m user@company.com --start-date 2026-01-01
atlas outlook restore -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30
atlas outlook restore -m user@company.com -T other@company.com
atlas outlook restore -m user@company.com -T other@company.com -f Inbox
```

| Option                      | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `-s, --snapshot <id>`       | Restore from a specific snapshot                                |
| `-m, --mailbox <email>`     | Restore from all snapshots for this mailbox                     |
| `-T, --target <email>`      | Target mailbox for cross-mailbox restore (defaults to source)   |
| `-f, --folder <name>`       | Restore only messages from this folder or its subfolders        |
| `--message <ref>`           | Restore a single message by `#` index from `atlas outlook list` |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date                 |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date                |
| `-t, --tenant <id>`         | Override tenant ID                                              |
| `--include-recoverable-items` | Also include hard-deleted and hold-retained mail; excluded by default |

Exactly one of `--snapshot` or `--mailbox` is required; passing both exits `1`, as described under [`atlas outlook`](#atlas-outlook). `-T, --target` works in either mode. In mailbox mode, entries are deduplicated across snapshots (newest version of each message wins). Cross-mailbox restores preserve the original folder names from the source mailbox. Nested source folders are recreated as nested subfolders under the `Restore-{timestamp}` root, so `Inbox/Projects/2026` restores to `Restore-.../Inbox/Projects/2026` instead of collapsing into one flat level.

Restored messages retain their original received/sent timestamps, appear as received mail (not drafts), and include all backed-up attachments. Large attachments (>3 MB) use Graph upload sessions with chunked transfer.

Messages archived as RFC 5322 MIME are parsed at restore time and recreated through Graph's JSON message-create path rather than imported as MIME. That is a deliberate choice: Graph's MIME import always marks the created message as a draft, and neither an `X-Unsent: 0` header nor a `PR_MESSAGE_FLAGS` patch clears the flag, so importing would hand the user thousands of drafts. The restored copy is therefore normal mail with its original timestamps, but it does not carry the original `Received:` chain. The archived object still does -- use [`atlas outlook save`](#atlas-outlook-save) when you need the original bytes.

::: details `-f` and pre-2.1.0 MIME snapshots
A folder filter matches on the `folder_id` recorded in the manifest. Snapshots written before Atlas stamped that field carry it on their Graph JSON entries, where it is recovered from the stored payload, but a MIME entry has nowhere to recover it from: RFC 822 does not record which folder a message sat in.

Those entries are therefore skipped by `-f` and reported on stderr with a count. Restore or save the whole snapshot without `-f` to include them. Snapshots taken by any current version stamp `folder_id` on every entry and are unaffected.
:::

### `atlas outlook list`

Browse backed-up data at three zoom levels. Subjects are hidden by default for data protection. The mailbox overview includes a `Type` column sourced from each mailbox's newest manifest that recorded a purpose (`user`, `shared`, `room`, ...; `--` when never recorded).

```bash
atlas outlook list                              # all mailboxes with summary stats
atlas outlook list -m user@company.com          # all snapshots for a mailbox
atlas outlook list -s <snapshot-id>             # messages inside a snapshot (first 50)
atlas outlook list -s <snapshot-id> --all       # all messages
atlas outlook list -s <snapshot-id> -S          # reveal email subjects
```

| Option                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `-m, --mailbox <email>` | Show snapshots for this mailbox                               |
| `-s, --snapshot <id>`   | Show messages inside this snapshot                            |
| `--all`                 | Show all messages (default caps at 50)                        |
| `-S, --subjects`        | Reveal email subjects (hidden by default for data protection) |
| `-t, --tenant <id>`     | Override tenant ID                                            |

### `atlas outlook read`

Decrypt and display a single backed-up message. Messages are referenced by their `#` index from `atlas outlook list` output. Attachment metadata (name, MIME type, size) is listed below the body when present, including attachments embedded inside an archived MIME message.

```bash
atlas outlook read -s <snapshot-id> --message 34
atlas outlook read -s <snapshot-id> --message 34 --raw
atlas outlook read -s <snapshot-id> --message 34 --raw > message.eml
```

| Option                | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `-s, --snapshot <id>` | Snapshot containing the message                                    |
| `--message <ref>`     | Message `#` from `atlas outlook list`, or full Graph message ID    |
| `--raw`               | Output the stored object verbatim instead of formatted headers + body |
| `-t, --tenant <id>`   | Override tenant ID                                                 |

What `--raw` prints depends on the format of the stored object. For a message archived as RFC 5322 MIME -- the default for snapshots taken by this version -- Atlas writes the decrypted MIME bytes to stdout verbatim: no banner, no colour, no added trailing newline. Redirecting that output produces a valid `.eml` file with its original `Received:` chain, `Authentication-Results`, and any S/MIME payload intact, which is what you want when handing a single message to an investigator or verifying a DKIM signature by hand.

For a legacy entry stored as a Graph JSON payload, `--raw` prints pretty-printed JSON with two-space indentation, exactly as it did before. Check a manifest entry's `payload_format` field if you need to know which to expect: `"mime"` means original bytes, an absent field means legacy JSON.

The formatted view is identical for both formats -- subject, from, to, cc, date, a separator, then the decoded `text/plain` body, falling back to the HTML part converted to text. For MIME entries Atlas parses that view out of the archived bytes, so no separate attachment objects are needed to list the attachments.

### `atlas outlook save`

Export backed-up emails as standard `.eml` files (RFC 5322) in a compressed zip archive. Messages archived as MIME are written **byte-for-byte** from the stored object -- no re-encoding, so the exported file is the message Exchange received. Legacy entries stored as Graph JSON are reconstructed into `.eml` at export time, as they always were. Attachments are embedded as MIME parts in both cases. Every message and attachment is SHA-256 verified after decryption by default.

::: warning Exported archives are marked as internet-sourced on Windows
On Windows, Atlas stamps the archive with Mark-of-the-Web: a `Zone.Identifier` alternate data stream carrying `ZoneId=3` (Internet). The content came from a Microsoft 365 tenant over the network, and Atlas does not vet it, so an export must not be the step that strips a protection the same file would have had if it arrived by browser or mail attachment. Without the mark, Office opens recovered documents with macros enabled; with it, they open in [Protected View](https://learn.microsoft.com/en-us/microsoft-365-apps/security/internet-macros-blocked) and macros are blocked.

**This propagates.** Windows Explorer and WinRAR copy the mark onto every extracted file (7-Zip only since 22.0, and not by default), so a 10,000-file recovery yields 10,000 files in Protected View and no macro-bearing workbook that runs. That is intended, and it is the behaviour operators notice first. When you have decided the content is trustworthy, clear it with PowerShell:

```powershell
Get-ChildItem -Recurse .\Restore-2026-03-10 | Unblock-File
```

Nothing is written on macOS or Linux, which have no equivalent. If the target filesystem cannot hold an alternate data stream (FAT32 or exFAT removable media, SMB to a non-NTFS server) the export still succeeds and logs a warning: a recovered archive is worth more than its mark.
:::

**Snapshot mode:**

```bash
atlas outlook save -s <snapshot-id>
atlas outlook save -s <snapshot-id> -f Inbox
atlas outlook save -s <snapshot-id> --message 42
atlas outlook save -s <snapshot-id> -o ~/Downloads/backup.zip
atlas outlook save -s <snapshot-id> --skip-verify
```

**Mailbox mode:**

```bash
atlas outlook save -m user@company.com
atlas outlook save -m user@company.com -f Inbox
atlas outlook save -m user@company.com --start-date 2026-01-01
atlas outlook save -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30
```

| Option                      | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `-s, --snapshot <id>`       | Save from a specific snapshot                                |
| `-m, --mailbox <email>`     | Save from all snapshots for this mailbox                     |
| `-f, --folder <name>`       | Save only messages from this folder or its subfolders        |
| `--message <ref>`           | Save a single message by `#` index from `atlas outlook list` |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date              |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date             |
| `-o, --output <path>`       | Output file path (default: `Restore-<timestamp>.zip`)        |
| `--skip-verify`             | Skip SHA-256 integrity checks (faster on low-power systems)  |
| `-t, --tenant <id>`         | Override tenant ID                                           |
| `--include-recoverable-items` | Also include hard-deleted and hold-retained mail; excluded by default |

With both `-s` and `-m`, the named snapshot is exported and `-m` is ignored with a warning; see [`atlas outlook`](#atlas-outlook). Earlier releases silently exported the whole mailbox instead.

The zip archive mirrors the Outlook folder hierarchy:

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

EML filenames use the format `YYYY-MM-DD_HHmmss_Sanitized-subject.eml` with timestamps from `receivedDateTime` for natural chronological sorting. Duplicate filenames within a folder get numeric suffixes (`_1`, `_2`).

Mixed archives are normal. A mailbox that was backed up before this version and has kept receiving incremental snapshots contains both legacy JSON entries and MIME entries; `save` walks the whole snapshot chain and writes an `.eml` for each, regardless of format.

If the output file already exists, Atlas prompts `Overwrite? [Y/n]` before proceeding.

### `atlas outlook delete`

Delete backed-up mail data with a confirmation prompt. Mail-scoped only: the tenant-wide purge is [`atlas delete`](#atlas-delete).

```bash
atlas outlook delete -m user@company.com        # delete all data + manifests for a mailbox
atlas outlook delete -s <snapshot-id>           # delete one snapshot manifest (data retained)
atlas outlook delete -m user@company.com -y     # skip confirmation prompt
```

| Option                  | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `-m, --mailbox <email>` | Delete all data, attachments, and manifests for a mailbox |
| `-s, --snapshot <id>`   | Delete a single snapshot manifest (data objects retained) |
| `-y, --yes`             | Skip confirmation prompt                                  |
| `-t, --tenant <id>`     | Override tenant ID                                        |

When Object Lock retention protects objects, delete commands return non-zero and report retained items separately from generic failures. "Retained" means a backend named Object Lock as the reason and the object becomes deletable when retention expires. Anything else, such as an IAM denial or an unreachable endpoint, is reported as a failure, because it will not resolve on its own.

::: details Deletion ordering
Atlas deletes **manifests first**, then data objects. This ordering is safe: if deletion is interrupted mid-way, you are left with orphan data blobs (harmless, can be cleaned up later) rather than dangling manifest references that point to missing data.

When using `--snapshot`, only the manifest file is removed. The underlying data objects are retained because they may be referenced by other snapshots (content-addressed deduplication).
:::

::: details Erasure in versioned buckets
Every delete removes the object **and all of its noncurrent versions**. This matters wherever bucket versioning is on, which is everywhere Object Lock is used, since versioning is its prerequisite. Deleting a key without naming a version writes a delete marker: the object disappears from listings while every byte stays retrievable, so a deletion that reports success would not have erased anything.
:::

### `atlas outlook status`

Check whether a mailbox backup is up to date by peeking at Microsoft Graph delta state. This does **not** run a backup. It only queries the delta endpoint with the saved delta links from the latest manifest to detect pending changes.

```bash
atlas outlook status -m user@company.com
atlas outlook status -m user@company.com -t <tenant-id>
```

| Option                  | Description                    |
| ----------------------- | ------------------------------ |
| `-m, --mailbox <email>` | Mailbox to check (required)    |
| `-t, --tenant <id>`     | Override tenant ID from config |

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

### `atlas outlook mailboxes`

List tenant mailboxes directly from Microsoft Graph (live data, not from the backup catalog). Shows email address, display name, Exchange Online license status, account status, mailbox type, creation date, and optionally mailbox size and In-Place Archive state.

```bash
atlas outlook mailboxes
atlas outlook mailboxes --licensed-only
atlas outlook mailboxes -t <tenant-id>
```

| Option              | Description                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- |
| `--licensed-only`   | Only show mailboxes with an active Exchange Online license (excludes shared mailboxes) |
| `-t, --tenant <id>` | Override tenant ID from config                                                         |

::: tip
Mailbox size requires the `Reports.Read.All` Graph API permission. If the permission is not granted, the Size column is omitted without error.

The `Type` column shows the Graph `mailboxSettings.userPurpose` value (`user`, `shared`, `room`, `equipment`, ...). To keep discovery fast, it is only resolved for unlicensed mailboxes; `--` means the purpose was not resolved. Note that `--licensed-only` excludes shared mailboxes, which are typically unlicensed.
:::

::: warning An In-Place Archive is not backed up
The `Archive` column comes from the same `Reports.Read.All` report and reports whether the mailbox has an **In-Place Archive** (Online Archive). Graph cannot read archive mailboxes at all, so that content is outside backup scope, and the command prints a warning naming every affected mailbox.

`--` means **unknown**, not "no archive": either the permission is missing or the report omitted the column. Atlas does not report coverage it cannot confirm.

This is not the `Archive` folder that Outlook's Archive button uses; that folder is in the primary mailbox and is backed up normally. See [In-Place Archive is out of scope](../security.md#in-place-archive-is-out-of-scope).
:::

## `atlas delete`

Tenant-wide deletion, across every workload. This is a top-level command rather than a subcommand of `outlook`, because the purge sweeps the whole bucket and nothing about it is mail-scoped.

```bash
atlas delete --purge        # delete EVERYTHING in the tenant bucket
atlas delete --purge -y     # skip the typed confirmation
```

| Option              | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `--purge`           | Delete all data, manifests, and encryption keys (irreversible)    |
| `-y, --yes`         | Skip the typed confirmation, for scheduled and scripted runs      |
| `-t, --tenant <id>` | Override tenant ID; the typed confirmation checks against this ID |

`atlas delete` without `--purge` exits non-zero and deletes nothing: a tenant wipe is never the default reading of an incomplete command. For scoped deletes use `atlas outlook delete`, `atlas onedrive delete`, or `atlas sharepoint delete`.

Interactively, the purge asks for the tenant ID to be typed back and aborts on anything else:

```
[!] This will delete ALL data for tenant <tenant-id> across Outlook, OneDrive and SharePoint (data, manifests, encryption keys)
Type the tenant ID to confirm:
```

A keypress is not enough here. The mistake this catches is not a mistyped `y` but a purge aimed at the wrong tenant, which typing the target is the only prompt that can catch. Workload-scoped deletes keep the single-keypress `y/n` prompt, deliberately: making every delete laborious trains operators to pass `-y` everywhere, which would remove the guard that matters. `-y` still bypasses the prompt entirely, so scheduled jobs and the E2E suite are unaffected.

`--purge` sweeps the whole bucket rather than a fixed list of prefixes, so Outlook, OneDrive, SharePoint, the identity registry, and any tree a later release adds all go. **Everything** is deleted including the encrypted DEK at `_meta/dek.enc`. The DEK is deleted last, and only if nothing survived: dropping the key while its ciphertext is still retained would leave data that can neither be restored nor be claimed erased. This is irreversible. All data for the tenant becomes permanently inaccessible.

Before v2.2.0 this was `atlas outlook delete --purge`. That flag is gone; scripts must call `atlas delete --purge`.

## `atlas onedrive`

Back up and verify OneDrive files per user using Graph delta sync. Blobs and manifests live under the `onedrive/` prefix in the tenant bucket (see [OneDrive Backup](/onedrive-backup)). When `-o` contains `@`, Atlas resolves the mailbox to an Entra object ID via `GET /users/{email}` before touching storage keys.

A snapshot is a delta: its manifest lists only what changed in that run. `restore`, `save` and `verify` therefore resolve the snapshot's **manifest chain**, the target manifest plus every older manifest for the same owner, merged newest-first and deduplicated by drive item. Restoring the newest snapshot gives the whole drive as it stood at that moment, not just the last few changed files. A file whose newest entry is a deletion stays deleted: the tombstone wins over the older stored version, so a restore never resurrects a file the user removed.

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

| Option           | Description                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| `backup`         | Incremental sync; use `--full` to ignore saved delta state               |
| `restore`        | Restore files from a snapshot to the user's (or another user's) OneDrive |
| `list-snapshots` | List snapshot IDs and timestamps for the owner                           |
| `list-versions`  | List indexed versions for one file (`-f` file ID or path)                |
| `restore-version`| Push stored file versions back into the drive, one file or a whole rollback |
| `verify`         | Decrypt manifests/blobs for a snapshot and check SHA-256 + index rows    |
| `status`         | Report pending Graph changes per drive without backing up                |
| `delete`         | Delete the owner's OneDrive backups, or a single snapshot                |

**`atlas onedrive backup`**

| Option                 | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `-o, --owner <id>`     | User email or Entra object ID (required)                              |
| `--full`               | Force full crawl ignoring saved delta links                           |
| `--folder <path>`      | Back up only this folder and its subfolders; see note below           |
| `--retention-days <n>` | Apply Object Lock **default retention** for `n` days (see note below) |
| `--lock-mode <mode>`   | Object Lock mode (`governance` or `compliance`, default `governance`); requires `--retention-days` |
| `-t, --tenant <id>`    | Override tenant ID from config                                        |

While the backup runs, a live dashboard shows one row per drive: delta fetch (`fetching changes...`), then per-item progress with rate and ETA, finishing as `[ok]` with stored/dedup/version counts or `[==] up to date` when an incremental delta has no changes. Non-interactive runs (cron/CI) print one plain log line per finished drive instead. Service messages (version syncs, warnings) print above the live region.

::: details Object Lock semantics for OneDrive/SharePoint
Unlike Outlook (which stamps a per-object `retain_until` on each write), OneDrive and SharePoint apply immutability as **bucket default retention** (`PutObjectLockConfiguration`): every new object version (files, file versions, manifests, delta cursors) inherits the lock automatically, so no write path can bypass it. Two consequences: the setting **persists on the bucket** and covers all subsequent writes from any command, and the bucket must be lock-capable (created with Object Lock; see `atlas storage-check` and the migration runbook in the self-hosting docs) or the backup fails fast with `ObjectLockUnsupportedError`. Frequently-overwritten small objects (cursors, indexes) accumulate locked noncurrent versions until retention expires; the bucket housekeeping lifecycle rules clean them up afterwards.
:::

::: details How --folder interacts with delta state
Graph's drive delta is drive-wide, so `--folder` filters the result rather than the query. The run still enumerates the whole drive, but only items inside the folder are downloaded, hashed, version-synced and written, which is where a drive backup spends its time.

A saved delta link records how far the **drive** was consumed, not how far the folder was. Resuming one under a different scope would skip changes the previous run filtered out, so **changing `--folder` between runs forces a full re-crawl**, as does switching between a scoped and an unscoped backup. Repeated runs with the same value stay incremental. The scope in force is stored in the delta cursor, and the run logs the re-crawl when it detects a change.

A snapshot taken with `--folder` contains only that folder's files. Restoring it restores only those files, so a scoped backup is not a substitute for a whole-drive one unless the scope covers everything you need.
:::

**`atlas onedrive restore`**

| Option                     | Description                                                                       |
| -------------------------- | --------------------------------------------------------------------------------- |
| `-o, --owner <id>`         | User email or Entra object ID (required)                                           |
| `-s, --snapshot <id>`      | Snapshot to restore from (required)                                                |
| `--target-owner <id>`      | Restore to a different user's OneDrive (defaults to owner)                         |
| `--destination <path>`     | Folder to restore under, created when missing (default: `/Restore-<timestamp>`)    |
| `--in-place`               | Restore to the original paths instead of a restore root                            |
| `--name <filename>`        | Rename the restored file; rejected unless exactly one file matches                 |
| `--file-filter <paths...>` | Only restore specific files by ID or path                                          |
| `-c, --conflict <mode>`    | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`)          |
| `-t, --tenant <id>`        | Override tenant ID from config                                                     |

A drive restore nests under `/Restore-<timestamp>` at the target drive root and recreates the original folder structure beneath it, matching how Outlook restores have always worked. `--in-place` reproduces the pre-4.0.0 behaviour of writing back over the original paths; it is never the default, because `--conflict rename` turns a repeated in-place restore into suffixed duplicates scattered through live content rather than a failure. See [Where restored files land](/onedrive-backup#where-restored-files-land).

Identifiers are matched case-insensitively: `--owner`, `--site`, and `--file-filter` all accept whatever case a listing or portal shows. Owner and site IDs are lowercased before they become storage keys, so one identifier always addresses one tree. Earlier releases wrote a second tree for a second spelling and deleted from whichever one they were handed.

`--site` accepts the same three forms on **every** command that takes it, including `replicate` and `rehydrate`: a browser URL (`https://contoso.sharepoint.com/sites/Engineering`), the Graph short form (`contoso.sharepoint.com:/sites/Engineering`), or a composite site ID (`contoso.sharepoint.com,<siteGuid>,<webGuid>`). URLs and short forms are resolved through Graph before any storage key is built; a composite ID is passed through untouched, so disaster recovery with `rehydrate` still works when Graph is unreachable.

**`atlas onedrive list-snapshots`**

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Override tenant ID from config           |

**`atlas onedrive list-versions`**

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-f, --file <ref>`  | Graph file ID or drive path (required)   |
| `-t, --tenant <id>` | Override tenant ID from config           |

**`atlas onedrive restore-version`**

Restores the version bytes Atlas holds. Use it to roll a file back past a bad
edit, or a whole folder back past a mass encrypt-and-sync event.

| Option              | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required)                                     |
| `-f, --file <ref>`  | Graph file ID or drive path; required with `--version`                       |
| `--version <id>`    | Exact stored version, as shown in the `Version` column of `list-versions`    |
| `--before <iso>`    | Restore each file's newest version at or before this instant                  |
| `--path <prefix>`   | Limit a `--before` rollback to this folder and below                         |
| `--in-place`        | Upload over the original file instead of writing a copy beside it            |
| `-t, --tenant <id>` | Override tenant ID from config                                               |

Either `--file` with `--version`, or `--before`. `--version` alone is rejected
because a version id is only unique within one file, and `--path` cannot be
combined with `--file`, since a folder scope and a single file are two
different requests.

::: warning Nothing is overwritten unless you ask
The default writes a sibling named `report (restored 2026-03-01T08-15-00Z).docx`
and leaves the live file untouched, so a rollback can be inspected before it is
adopted. `--in-place` uploads over the original path instead. Even then the
previous content is not destroyed: Microsoft 365 records the upload as a new
version and keeps the one it replaced in the file's own version history.
:::

Restored files keep the modification time the version had, not the time of the
restore, so a rolled-back document does not look like it was authored during
the incident.

A file with no version stored at or before the cutoff is **reported, not
skipped silently**, and counts toward the skipped total. Treat that list as the
work still outstanding: those files have no pre-incident copy in the backup.

::: details Why Atlas uploads its own bytes instead of calling Graph
Microsoft Graph can promote a previous version in place with `restoreVersion`,
and Atlas deliberately does not use it. That call only works on a version the
service still holds, so it fails exactly when a backup is needed: history
trimmed by a retention policy, the file deleted, or the library gone. Its result
also cannot be checked against the manifest checksum. Atlas uploads the bytes
it stored and verified, which is the only path that guarantees the content you
get is the content the backup recorded. `list-versions` shows what is available
to restore.
:::

**`atlas onedrive save`**

Save decrypted files from a OneDrive snapshot to a local zip archive. The archive preserves the original folder structure. Each file is SHA-256 verified after decryption by default.

```bash
atlas onedrive save -o user@company.com -s od-snap-1735689600000-a1b2c3
atlas onedrive save -o user@company.com -s od-snap-123 -O ~/Downloads/backup.zip
atlas onedrive save -o user@company.com -s od-snap-123 --file-filter "/Documents/report.docx"
atlas onedrive save -o user@company.com -s od-snap-123 --skip-verify
```

| Option                     | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `-o, --owner <id>`         | User email or Entra object ID (required)       |
| `-s, --snapshot <id>`      | OneDrive snapshot ID (required)                |
| `--file-filter <paths...>` | Only save specific files (by ID or path)       |
| `-O, --output <path>`      | Output zip file path (default: auto-generated) |
| `--skip-verify`            | Skip SHA-256 integrity checks                  |
| `-t, --tenant <id>`        | Override tenant ID from config                 |

The zip archive mirrors the OneDrive folder hierarchy:

```
onedrive-od-snap-123-2026-05-24T14-30-00.zip
  Documents/
    report.docx
    budget.xlsx
  Photos/
    vacation.jpg
```

Files larger than 4 MiB use streaming decryption to avoid buffering the full ciphertext in memory.

**`atlas onedrive verify`**

| Option                | Description                              |
| --------------------- | ---------------------------------------- |
| `-o, --owner <id>`    | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | OneDrive snapshot id (required)          |
| `-t, --tenant <id>`   | Override tenant ID from config           |

**`atlas onedrive status`**

Reports pending Graph changes per drive by replaying the saved delta links from the latest manifest chain. Reads only: no backup runs and nothing is written.

| Option              | Description                              |
| ------------------- | ---------------------------------------- |
| `-o, --owner <id>`  | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Override tenant ID from config           |

**`atlas onedrive delete`**

Deletes the owner's OneDrive backups behind the same confirmation prompt as the Outlook delete. Without `-s` it sweeps the owner's `manifests`, `data`, `index`, `_meta` and `staging` prefixes, staging included so an interrupted large-file upload does not leave file content parked in the bucket. With `-s` only that snapshot's manifest is removed; the content-addressed blobs stay, because other snapshots may reference them.

| Option                | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `-o, --owner <id>`    | User email or Entra object ID (required)             |
| `-s, --snapshot <id>` | Delete only this snapshot instead of every backup    |
| `-y, --yes`           | Skip confirmation prompt                             |
| `-t, --tenant <id>`   | Override tenant ID from config                       |

::: tip Permissions
Application permissions `Files.Read.All` and `User.Read.All` are required for backup and read operations; `Files.ReadWrite.All` is additionally required for restore. See Details and storage layout are documented on the [OneDrive Backup](/onedrive-backup) page.
:::

## `atlas sharepoint`

Back up, restore, and verify SharePoint document library files per site using Graph delta sync. Blobs and manifests live under the `sharepoint/` prefix in the tenant bucket. SharePoint backup is site-targeted (not user-targeted like OneDrive). The site can be specified as a full URL or a Graph site ID.

As with OneDrive, a snapshot is a delta and `restore`, `save` and `verify` resolve the full manifest chain for the site. See the note under [`atlas onedrive`](#atlas-onedrive) for how tombstones and superseded versions are merged.

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

| Subcommand       | Description                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `backup`         | Incremental sync; use `--full` to ignore saved delta state            |
| `list-snapshots` | List all SharePoint snapshots for a site                              |
| `list-versions`  | List all backed-up versions for a specific file                       |
| `restore-version`| Push stored file versions back into the library, one file or a whole rollback |
| `restore`        | Restore files from a snapshot back to the site's document libraries   |
| `save`           | Decrypt and save files from a snapshot to a local zip archive         |
| `verify`         | Decrypt manifests/blobs for a snapshot and check SHA-256 + index rows |
| `status`         | Report pending Graph changes per document library without backing up  |
| `delete`         | Delete the site's SharePoint backups, or a single snapshot            |

**`atlas sharepoint backup`**

| Option                 | Description                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| `--site <url-or-id>`   | SharePoint site URL or Graph site ID (required)                                   |
| `--full`               | Force full crawl ignoring saved delta links                                       |
| `--include-subsites`   | Also back up every subsite beneath the site, one snapshot per subsite             |
| `--retention-days <n>` | Apply Object Lock **default retention** for `n` days (same semantics as OneDrive) |
| `--lock-mode <mode>`   | Object Lock mode (`governance` or `compliance`, default `governance`); requires `--retention-days` |
| `-t, --tenant <id>`    | Override tenant ID from config                                                    |

:::: tip Subsites are separate sites
`GET /sites/{site-id}/sites` returns only a site's _direct_ subsites, so Atlas walks the tree explicitly. By default a backup covers the named site alone and emits one warning per uncovered subsite. Classic site collections with nested subsite trees would otherwise look fully protected while entire subsites sat outside the backup.

`--include-subsites` backs up the whole tree. Each subsite is a Graph site with its own drives, so it gets **its own snapshot under its own `site_id` prefix** (`sharepoint/manifests/{site_id}/...`), identical in structure to a root-site backup. Restore addressing is therefore unchanged: restore a subsite by naming that subsite.

Graph returns only the subsites the application can read. A subsite that cannot be enumerated is reported as a warning rather than treated as absent, so an access gap never silently narrows backup scope. Traversal is bounded at 20 levels.
::::

**`atlas sharepoint list-snapshots`**

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>`  | Override tenant ID from config                  |

**`atlas sharepoint list-versions`**

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-f, --file <ref>`   | File ID or path to look up (required)           |
| `-t, --tenant <id>`  | Override tenant ID from config                  |

**`atlas sharepoint restore-version`**

| Option               | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required)                           |
| `-f, --file <ref>`   | File ID or path; required with `--version`                                |
| `--version <id>`     | Exact stored version, as shown by `list-versions`                         |
| `--before <iso>`     | Restore each file's newest version at or before this instant               |
| `--path <prefix>`    | Limit a `--before` rollback to this folder and below                      |
| `--in-place`         | Upload over the original file instead of writing a copy beside it         |
| `-t, --tenant <id>`  | Override tenant ID from config                                            |

Identical semantics to [`atlas onedrive restore-version`](#atlas-onedrive),
including the copy-by-default placement and the reason Atlas uploads its own
stored bytes rather than calling Graph's `restoreVersion`. Versions are restored
into the document library they were captured from.

**`atlas sharepoint restore`**

| Option                      | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `--site <url-or-id>`        | SharePoint site URL or Graph site ID (required)                                |
| `-s, --snapshot <id>`       | SharePoint snapshot ID (required)                                              |
| `--target-site <url-or-id>` | Restore to a different site (defaults to original)                             |
| `--destination <path>`      | Folder to restore under, created when missing (default: `/Restore-<timestamp>`) |
| `--in-place`                | Restore to the original paths instead of a restore root                         |
| `--name <filename>`         | Rename the restored file; rejected unless exactly one file matches             |
| `--file-filter <paths...>`  | Only restore specific files (by ID or path)                                    |
| `-c, --conflict <mode>`     | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`)       |
| `-t, --tenant <id>`         | Override tenant ID from config                                                  |

Restored files nest under `Restore-<timestamp>` in each destination library, with the original
structure recreated beneath it. `--in-place` restores over the original paths, which was the
behaviour before 4.0.0. See
[Where restored files land](../sharepoint-backup.md#where-restored-files-land).

With `--target-site`, each file goes to the target library whose name matches the
one it was backed up from, or, when the restore comes from a single library,
to the target's only library. Anything ambiguous is refused: the file is skipped,
the candidate libraries are listed, and the command exits non-zero. Atlas never
writes into the source library instead. See
[Where a cross-site restore lands](../sharepoint-backup.md#where-a-cross-site-restore-lands).

**`atlas sharepoint save`**

Save decrypted files from a SharePoint snapshot to a local zip archive. The archive preserves the original folder structure from document libraries. Each file is SHA-256 verified after decryption by default.

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 -O ~/Downloads/backup.zip
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --file-filter "/Documents/report.docx"
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --skip-verify
```

| Option                     | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `--site <url-or-id>`       | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>`      | SharePoint snapshot ID (required)               |
| `--file-filter <paths...>` | Only save specific files (by ID or path)        |
| `-O, --output <path>`      | Output zip file path (default: auto-generated)  |
| `--skip-verify`            | Skip SHA-256 integrity checks                   |
| `-t, --tenant <id>`        | Override tenant ID from config                  |

**`atlas sharepoint verify`**

| Option                | Description                                     |
| --------------------- | ----------------------------------------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>` | SharePoint snapshot ID (required)               |
| `-t, --tenant <id>`   | Override tenant ID from config                  |

**`atlas sharepoint status`**

Reports pending Graph changes per document library from the saved delta links. Reads only.

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>`  | Override tenant ID from config                  |

**`atlas sharepoint delete`**

Deletes the site's SharePoint backups behind a confirmation prompt. Without `-s` it sweeps the site's `manifests`, `data`, `index`, `_meta` and `staging` prefixes. With `-s` only that snapshot's manifest is removed and the shared blobs stay.

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID (required)   |
| `-s, --snapshot <id>` | Delete only this snapshot instead of every backup |
| `-y, --yes`           | Skip confirmation prompt                          |
| `-t, --tenant <id>`   | Override tenant ID from config                    |

::: tip Permissions
Application permissions `Sites.Read.All` and `Files.Read.All` are required for SharePoint backup and verification. Restore additionally requires `Sites.ReadWrite.All`.
:::

## `atlas storage-check`

Validate immutable backup readiness without running a backup. Reports versioning, Object Lock status, and the bucket class: `lock-capable` (can take retention policies), `versioned-only (legacy)`, or `unversioned (legacy)`. Legacy classes mean the bucket predates v2.1.0 auto-provisioning and needs the [migration runbook](/self-hosting/storage#migrating-a-legacy-bucket-to-object-lock) before immutability can be used. Exits non-zero when the bucket is not lock-ready, so it can gate scheduled jobs.

```bash
atlas storage-check
atlas storage-check --lock-mode governance --retention-days 30
atlas storage-check --lock-mode compliance --retention-days 365
```

| Option                 | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `--lock-mode <mode>`   | Planned Object Lock mode (`governance` or `compliance`) |
| `--retention-days <n>` | Planned retention period in days                        |
| `-t, --tenant <id>`    | Override tenant ID                                      |

## `atlas stats`

Show storage statistics across all backed-up services. By default the command reports Outlook, OneDrive, and SharePoint in one pass: per-service snapshot counts, item counts (messages or files), total encrypted storage size, and a monthly breakdown. Statistics are computed purely from the encrypted snapshot manifests in the bucket. No Microsoft Graph calls are made unless you scope to a OneDrive owner or SharePoint site that needs identity resolution.

```bash
atlas stats                            # all services: Outlook, OneDrive, SharePoint
atlas stats --service outlook          # Outlook bucket-level overview only
atlas stats -m user@company.com        # Outlook mailbox-level breakdown
atlas stats -o user@company.com        # OneDrive statistics for one owner
atlas stats -s https://contoso.sharepoint.com/sites/Engineering   # one site
atlas stats --top 5                    # limit owner/site tables to 5 rows
atlas stats --json                     # raw JSON output
```

| Option                    | Description                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `-m, --mailbox <email>`   | Outlook statistics for a specific mailbox (implies `--service outlook`)                    |
| `-o, --owner <email\|id>` | OneDrive statistics for a specific owner (implies `--service onedrive`)                    |
| `-s, --site <url\|id>`    | SharePoint statistics for a specific site (implies `--service sharepoint`)                 |
| `--service <name>`        | Limit output to one service: `outlook`, `onedrive`, `sharepoint`, or `all` (default `all`) |
| `--top <n>`               | Maximum owner/site rows in OneDrive/SharePoint tables (default 20)                         |
| `--json`                  | Output raw JSON instead of formatted tables                                                |
| `-t, --tenant <id>`       | Override tenant ID from config                                                             |

Only one of `--mailbox`, `--owner`, or `--site` may be used at a time; each scopes the output to its service. OneDrive and SharePoint sections list per-owner and per-site rollups (snapshots, files, size, last backup time) sorted by size descending, so the heaviest consumers surface first. `--owner` accepts an email (resolved via Graph to the owner object ID) or a raw object ID; `--site` accepts a site URL or composite site ID. Use `--json` for programmatic consumption in monitoring scripts or dashboards. With multiple services the payload is an object keyed by service name, with a single service it is that service's stats object.

## `atlas config`

Manage Atlas configuration in an encrypted local store, git-config style. Values are written to `~/.atlas/config.enc` (AES-256-GCM); the store key lives in the OS keyring (macOS Keychain or libsecret), so credentials never sit on disk or in the environment in plaintext. See [Configuration](../configuration.md) for precedence and [Security](../security.md) for the threat model.

```bash
atlas config tenant.id 4fa2a706-b26a-4bbe-9b1c-1e671b586b8f   # set + validate
pbpaste | atlas config client.secret -                        # "-" reads from stdin (no shell history)
atlas config client.secret                                    # get (secrets masked)
atlas config list                                             # all keys, values, sources
atlas config unset client.secret                              # remove from the store
atlas config validate                                         # live Graph + S3 connectivity check
```

| Usage                  | Description                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `config <key> <value>` | Validate and save a value to the encrypted store                                                                  |
| `config <key>`         | Print the current effective value (secrets masked)                                                                |
| `config list`          | Print every key with its value and source (`env`, `secure store`, `config file`)                                  |
| `config unset <key>`   | Remove a key from the encrypted store                                                                             |
| `config validate`      | Probe Microsoft Graph (token request) and S3 (`ListBuckets`) with the effective config; exits non-zero on failure |

Keys: `tenant.id`, `client.id`, `client.secret`, `s3.endpoint`, `s3.access-key`, `s3.secret-key`, `s3.region`, `encryption.passphrase`. Each value is format-checked on save (GUIDs, URL scheme, 12-character passphrase minimum), and once a credential group is complete the matching live probe runs automatically. Note that `ATLAS_*` environment variables still override stored values; the command warns when a saved value is shadowed.

## `atlas replicate`

Replicate snapshots to a secondary S3-compatible storage target. Ciphertext is copied as-is (no decryption). Only unreplicated snapshots and missing objects are transferred.

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

atlas replicate --status
atlas replicate --status -m user@company.com
atlas replicate --status -s <snapshot-id>
atlas replicate --status --site https://contoso.sharepoint.com/sites/Engineering
atlas replicate --status -o user@company.com
```

| Option                      | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `-s, --snapshot <id>`       | Replicate a specific snapshot, any workload                |
| `-m, --mailbox <email>`     | Replicate all unreplicated snapshots for a mailbox         |
| `--site <url-or-id>`        | Replicate all unreplicated snapshots for a SharePoint site |
| `-o, --owner <email-or-id>` | Replicate all unreplicated snapshots for a OneDrive owner  |
| `--target-endpoint <url>`   | Target S3 endpoint URL                                     |
| `--target-access-key <key>` | Target S3 access key                                       |
| `--target-secret-key <key>` | Target S3 secret key                                       |
| `--target-region <region>`  | Target S3 region (default: `us-east-1`)                    |
| `--target-config <path>`    | Path to JSON file with target S3 credentials               |
| `--status`                  | Show replication status instead of replicating             |
| `-t, --tenant <id>`         | Override tenant ID                                         |

::: tip Target Config File
The target config file is a JSON object with `s3_endpoint`, `s3_access_key`, `s3_secret_key`, and optionally `s3_region` and `target_id`. The encryption passphrase is shared from the main Atlas configuration.
:::

## `atlas rehydrate`

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

| Option                      | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `-s, --snapshot <id>`       | Recover a specific snapshot from the replica                 |
| `-m, --mailbox <email>`     | Recover all snapshots for a mailbox from the replica         |
| `--site <url-or-id>`        | Recover all SharePoint snapshots for a site from the replica |
| `-o, --owner <email-or-id>` | Recover all OneDrive snapshots for an owner from the replica |
| `--all`                     | Recover every workload: Outlook, OneDrive, and SharePoint    |
| `--source-endpoint <url>`   | Source replica S3 endpoint URL                               |
| `--source-access-key <key>` | Source replica S3 access key                                 |
| `--source-secret-key <key>` | Source replica S3 secret key                                 |
| `--source-region <region>`  | Source replica S3 region (default: `us-east-1`)              |
| `--source-config <path>`    | Path to JSON file with source S3 credentials                 |
| `-t, --tenant <id>`         | Override tenant ID                                           |

Scopes are matched in the order `--site`, `-o/--owner`, `-s/--snapshot`, `-m/--mailbox`, `--all`. `-s/--snapshot` works for all three workloads: the snapshot id says which one it belongs to (`od-snap-*` OneDrive, `sp-snap-*` SharePoint, `snap-*` Outlook), and the owning owner or site is resolved from storage, so it does not have to be named again. Combining `--site` or `-o/--owner` with `-s/--snapshot` addresses the same single snapshot explicitly. Owner and site identifiers are lowercased before they become storage keys, so any casing addresses the same tree.

`-o/--owner` accepts an email or a raw Entra ID object ID. Recovery resolves an email through Microsoft Graph only. Unlike `atlas onedrive` commands it does not write the resolved identity back to primary, because that write would bootstrap a fresh encryption key in the target bucket and block the replica's key from being copied (see _Encryption Key Safety_ below). Pass the object ID directly when Graph is unreachable or the user has been deleted from the directory.

::: tip What `--all` covers
`--all` recovers all three workloads: every Outlook mailbox (`manifests/`), every OneDrive owner (`onedrive/manifests/`), and every SharePoint site (`sharepoint/manifests/`) present on the replica. The summary breaks the run down per workload, so a recovery that restored only part of the tenant is visible instead of hidden behind one aggregate status line:

```
Workload    Scope       Copied  Skipped  Failed  Size
outlook     2-snapshots  35      0        0       433.3 KB
onedrive    1-owners     12      1        0       2.7 MB
sharepoint  1-sites      59      0        0       7.1 MB
```

A workload with no objects at all prints a warning naming it, because the replica held nothing for it. Verify that against the source before treating the drill as a pass.
:::

::: danger Rehydration Is Not Sync
Rehydration copies explicitly selected data from a designated replica to primary. It does not merge, diff, or resolve conflicts. After rehydration, primary resumes as the source of truth. Delta links in recovered manifests may be stale, so Atlas falls back to full sync on the next backup automatically.
:::

::: warning Encryption Key Safety
Rehydration needs the source replica's encryption key (`_meta/dek.enc`) on the primary. Atlas copies it automatically when the primary has none, and replaces it only when the key is provably the sole object in the primary bucket (a freshly auto-initialized bucket). If the primary already contains **any** other object (Outlook, OneDrive, or SharePoint data, or replication records) and its key differs from the source's, rehydration aborts with `DekOverwriteRefusedError` instead of making that data permanently undecryptable. If the primary's content is disposable, run `atlas delete --purge` first and rehydrate into the empty bucket.
:::
