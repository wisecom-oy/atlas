# CLI Commands

Complete reference for every Atlas CLI command.

## `atlas outlook`

Outlook mailbox backup, restore, and management commands. All mailbox operations live under this group; cross-cutting storage and replication commands remain at the root level.

### `atlas outlook backup`

Back up mailboxes from an M365 tenant to object storage. When a mailbox is specified with `-m`, backs up that single mailbox with a per-folder progress dashboard. When no mailbox is specified, discovers all Exchange-licensed mailboxes in the tenant and backs them up in parallel.

**Single mailbox:**

```bash
atlas outlook backup -m user@company.com                      # incremental backup
atlas outlook backup -m user@company.com --full                # force full sync (ignore delta state)
atlas outlook backup -m user@company.com -f Inbox Sent         # specific folders only
atlas outlook backup -m user@company.com -P 50                 # larger page size for fewer API round-trips
atlas outlook backup -m user@company.com --retention-days 30 --lock-mode governance
atlas outlook backup -m user@company.com --retention-days 365 --lock-mode compliance
atlas outlook backup -t <tenant-id> -m user@company.com        # explicit tenant
```

**Full tenant (all licensed mailboxes):**

```bash
atlas outlook backup                                           # back up all licensed mailboxes (4 concurrent)
atlas outlook backup -C 8                                      # increase parallel workers to 8
atlas outlook backup --full                                    # force full sync for all mailboxes
```

| Option                   | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `-m, --mailbox <id>`     | Specific mailbox to back up (backs up all licensed if omitted) |
| `-f, --folder <name...>` | Filter to specific folder(s) by display name                   |
| `--full`                 | Ignore saved delta links, run full enumeration                 |
| `-P, --page-size <n>`    | Graph API page size per delta request (1--100, default 10)     |
| `-C, --concurrency <n>`  | Parallel mailbox count for tenant backup (default 4)           |
| `--retention-days <n>`   | Apply Object Lock retention for `n` days                       |
| `--lock-mode <mode>`     | Object Lock mode (`governance` or `compliance`)                |
| `--require-immutability` | Fail if immutability cannot be enforced                        |
| `-t, --tenant <id>`      | Override tenant ID from config                                 |

::: tip Tenant-wide mode
When no `-m` flag is given, Atlas discovers all Exchange Online-licensed mailboxes via Microsoft Graph, then runs up to `-C` concurrent backup workers. A compact dashboard shows each active worker's mailbox, folder progress, and overall completion. The first Ctrl+C gracefully finishes active mailboxes; a second Ctrl+C force-quits immediately.
:::

::: details Page size tuning
The `--page-size` flag controls how many messages are requested per Graph API delta page via the `Prefer: odata.maxpagesize` header. This is a _hint_ -- the server may return fewer items when response payloads are large (e.g. messages with heavy HTML bodies or many inline images). Lower values reduce memory pressure and allow partial progress to be saved more frequently during interrupts. Higher values reduce HTTP round-trips but increase per-page processing time. The default of 10 is a conservative starting point; increase if you have many small messages and want fewer round-trips.
:::

::: details Immutability behavior
`--retention-days` makes the backup immutable-requested. Atlas resolves retention to an internal UTC `retain_until`, probes bucket capability (versioning + Object Lock), and fails fast when unsupported instead of silently downgrading to mutable writes.
:::

### `atlas outlook verify`

Verify integrity of a backup snapshot. Downloads every encrypted object from S3, decrypts it (which validates the GCM authentication tag against tampering), recomputes the SHA-256 hash of the plaintext, and compares it against the checksum stored in the manifest using constant-time comparison (`timingSafeEqual`).

```bash
atlas outlook verify -m user@company.com -s <snapshot-id>
atlas outlook verify -m user@company.com -s <snapshot-id> -t <tenant-id>
```

| Option                  | Description                                |
| ----------------------- | ------------------------------------------ |
| `-m, --mailbox <email>` | Mailbox that owns the snapshot (required)  |
| `-s, --snapshot <id>`   | Snapshot identifier to verify (required)   |
| `-t, --tenant <id>`     | Override tenant ID from config             |

::: details What exactly is verified?
`atlas outlook verify` checks **message body entries** listed in the manifest. Each message is downloaded, decrypted (GCM auth tag validates ciphertext integrity), and its plaintext SHA-256 is compared against the manifest checksum.

Attachments are **not separately verified** by this command. However, attachments are protected by GCM authentication -- any tampering will cause a decryption failure during restore or save operations. The verification scope is message bodies because those are the primary data objects tracked in manifests.
:::

### `atlas outlook restore`

Restore emails from backup to an M365 mailbox.

**Snapshot mode** -- restore from a specific snapshot:

```bash
atlas outlook restore -s <snapshot-id>
atlas outlook restore -s <snapshot-id> -f Inbox
atlas outlook restore -s <snapshot-id> --message 42
atlas outlook restore -s <snapshot-id> -m target@company.com
```

**Mailbox mode** -- aggregate all snapshots for a mailbox, deduplicate, and restore:

```bash
atlas outlook restore -m user@company.com
atlas outlook restore -m user@company.com -f Inbox
atlas outlook restore -m user@company.com --start-date 2026-01-01
atlas outlook restore -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30
atlas outlook restore -m user@company.com -T other@company.com
atlas outlook restore -m user@company.com -T other@company.com -f Inbox
```

| Option                      | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `-s, --snapshot <id>`       | Restore from a specific snapshot                              |
| `-m, --mailbox <email>`     | Restore from all snapshots for this mailbox                   |
| `-T, --target <email>`      | Target mailbox for cross-mailbox restore (defaults to source) |
| `-f, --folder <name>`       | Restore only messages from this folder                        |
| `--message <ref>`           | Restore a single message by `#` index from `atlas outlook list` |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date               |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date              |
| `-t, --tenant <id>`         | Override tenant ID                                            |

Either `--snapshot` or `--mailbox` is required. In mailbox mode, entries are deduplicated across snapshots (newest version of each message wins). Cross-mailbox restores preserve the original folder names from the source mailbox.

Restored messages retain their original received/sent timestamps, appear as received mail (not drafts), and include all backed-up attachments. Large attachments (>3 MB) use Graph upload sessions with chunked transfer.

### `atlas outlook list`

Browse backed-up data at three zoom levels. Subjects are hidden by default for data protection.

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

Decrypt and display a single backed-up message. Messages are referenced by their `#` index from `atlas outlook list` output. Attachment metadata (name, MIME type, size) is listed below the body when present.

```bash
atlas outlook read -s <snapshot-id> --message 34
atlas outlook read -s <snapshot-id> --message 34 --raw
```

| Option                | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `-s, --snapshot <id>` | Snapshot containing the message                           |
| `--message <ref>`     | Message `#` from `atlas outlook list`, or full Graph message ID |
| `--raw`               | Output full JSON blob instead of formatted headers + body |
| `-t, --tenant <id>`   | Override tenant ID                                        |

### `atlas outlook save`

Export backed-up emails as standard `.eml` files (RFC 5322) in a compressed zip archive. Messages include all backed-up attachments embedded as MIME parts. Every message and attachment is SHA-256 verified after decryption by default.

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

| Option                      | Description                                                 |
| --------------------------- | ----------------------------------------------------------- |
| `-s, --snapshot <id>`       | Save from a specific snapshot                               |
| `-m, --mailbox <email>`     | Save from all snapshots for this mailbox                    |
| `-f, --folder <name>`       | Save only messages from this folder                         |
| `--message <ref>`           | Save a single message by `#` index from `atlas outlook list` |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date             |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date            |
| `-o, --output <path>`       | Output file path (default: `Restore-<timestamp>.zip`)       |
| `--skip-verify`             | Skip SHA-256 integrity checks (faster on low-power systems) |
| `-t, --tenant <id>`         | Override tenant ID                                          |

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

If the output file already exists, Atlas prompts `Overwrite? [Y/n]` before proceeding.

### `atlas outlook delete`

Delete backed-up data with confirmation prompt.

```bash
atlas outlook delete -m user@company.com        # delete all data + manifests for a mailbox
atlas outlook delete -s <snapshot-id>           # delete one snapshot manifest (data retained)
atlas outlook delete --purge                    # delete EVERYTHING in the tenant bucket
atlas outlook delete --purge -y                 # skip confirmation prompt
```

| Option                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `-m, --mailbox <email>` | Delete all data, attachments, and manifests for a mailbox      |
| `-s, --snapshot <id>`   | Delete a single snapshot manifest (data objects retained)      |
| `--purge`               | Delete all data, manifests, and encryption keys (irreversible) |
| `-y, --yes`             | Skip confirmation prompt                                       |
| `-t, --tenant <id>`     | Override tenant ID                                             |

When Object Lock retention protects objects, delete commands return non-zero and report retained items separately from generic failures.

::: details Deletion ordering
Atlas deletes **manifests first**, then data objects. This ordering is safe: if deletion is interrupted mid-way, you are left with orphan data blobs (harmless, can be cleaned up later) rather than dangling manifest references that point to missing data.

When using `--snapshot`, only the manifest file is removed -- the underlying data objects are retained because they may be referenced by other snapshots (content-addressed deduplication).

When using `--purge`, **everything** is deleted including the encrypted DEK at `_meta/dek.enc`. This is irreversible -- all data for the tenant becomes permanently inaccessible.
:::

### `atlas outlook status`

Check whether a mailbox backup is up to date by peeking at Microsoft Graph delta state. This does **not** run a backup -- it only queries the delta endpoint with the saved delta links from the latest manifest to detect pending changes.

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
------------------
-- Atlas Status --
------------------
[*] Tenant:  ec216cb5-...
[*] Mailbox: user@company.com
[*] Last backup: 2026-03-18 14:30 (snap-abc123)

  Folder                      Status              Pending
  ---------------------------------------------------------
  Inbox                       up-to-date          0
  Sent Items                  3 change(s)         3
  Archive                     never backed up     -
  ---------------------------------------------------------

[*] Overall: 3 pending change(s), 1 folder(s) never backed up across 3 folder(s)
```

### `atlas outlook mailboxes`

List tenant mailboxes directly from Microsoft Graph (live data, not from the backup catalog). Shows email address, display name, Exchange Online license status, account status, creation date, and optionally mailbox size.

```bash
atlas outlook mailboxes
atlas outlook mailboxes --licensed-only
atlas outlook mailboxes -t <tenant-id>
```

| Option              | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `--licensed-only`   | Only show mailboxes with an active Exchange Online license |
| `-t, --tenant <id>` | Override tenant ID from config                             |

::: tip
Mailbox size requires the `Reports.Read.All` Graph API permission. If the permission is not granted, the Size column is omitted without error.
:::

## `atlas onedrive`

Back up and verify OneDrive files per user using Graph delta sync. Blobs and manifests live under the `onedrive/` prefix in the tenant bucket (see [OneDrive Backup](/onedrive-backup)). When `-o` contains `@`, Atlas resolves the mailbox to an Entra object ID via `GET /users/{email}` before touching storage keys.

```bash
atlas onedrive backup -o user@company.com
atlas onedrive backup -o user@company.com --full
atlas onedrive restore -o user@company.com -s od-snap-1735689600000-a1b2c3
atlas onedrive restore -o user@company.com -s od-snap-123 --target-owner other@company.com
atlas onedrive restore -o user@company.com -s od-snap-123 --conflict replace
atlas onedrive list-snapshots -o user@company.com
atlas onedrive list-versions -o user@company.com -f "Documents/report.docx"
atlas onedrive verify -o user@company.com -s od-snap-1735689600000-a1b2c3
```

| Option | Description |
| --- | --- |
| `backup` | Incremental sync; use `--full` to ignore saved delta state |
| `restore` | Restore files from a snapshot to the user's (or another user's) OneDrive |
| `list-snapshots` | List snapshot IDs and timestamps for the owner |
| `list-versions` | List indexed versions for one file (`-f` file ID or path) |
| `verify` | Decrypt manifests/blobs for a snapshot and check SHA-256 + index rows |

**`atlas onedrive backup`**

| Option | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `--full` | Force full crawl ignoring saved delta links |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas onedrive restore`**

| Option | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | Snapshot to restore from (required) |
| `--target-owner <id>` | Restore to a different user's OneDrive (defaults to owner) |
| `--file-filter <paths...>` | Only restore specific files by ID or path |
| `-c, --conflict <mode>` | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`) |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas onedrive list-snapshots`**

| Option | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas onedrive list-versions`**

| Option | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-f, --file <ref>` | Graph file ID or drive path (required) |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas onedrive save`**

Save decrypted files from a OneDrive snapshot to a local zip archive. The archive preserves the original folder structure. Each file is SHA-256 verified after decryption by default.

```bash
atlas onedrive save -o user@company.com -s od-snap-1735689600000-a1b2c3
atlas onedrive save -o user@company.com -s od-snap-123 -O ~/Downloads/backup.zip
atlas onedrive save -o user@company.com -s od-snap-123 --file-filter "/Documents/report.docx"
atlas onedrive save -o user@company.com -s od-snap-123 --skip-verify
```

| Option | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | OneDrive snapshot ID (required) |
| `--file-filter <paths...>` | Only save specific files (by ID or path) |
| `-O, --output <path>` | Output zip file path (default: auto-generated) |
| `--skip-verify` | Skip SHA-256 integrity checks |
| `-t, --tenant <id>` | Override tenant ID from config |

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

| Option | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | OneDrive snapshot id (required) |
| `-t, --tenant <id>` | Override tenant ID from config |

::: tip Permissions
Application permissions `Files.Read.All` and `User.Read.All` are required for backup and read operations; `Files.ReadWrite.All` is additionally required for restore. See Details and storage layout are documented on the [OneDrive Backup](/onedrive-backup) page.
:::

## `atlas sharepoint`

Back up, restore, and verify SharePoint document library files per site using Graph delta sync. Blobs and manifests live under the `sharepoint/` prefix in the tenant bucket. SharePoint backup is site-targeted (not user-targeted like OneDrive). The site can be specified as a full URL or a Graph site ID.

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --full
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering -f /Documents/report.docx
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
```

| Subcommand | Description |
| --- | --- |
| `backup` | Incremental sync; use `--full` to ignore saved delta state |
| `list-snapshots` | List all SharePoint snapshots for a site |
| `list-versions` | List all backed-up versions for a specific file |
| `restore` | Restore files from a snapshot back to the site's document libraries |
| `save` | Decrypt and save files from a snapshot to a local zip archive |
| `verify` | Decrypt manifests/blobs for a snapshot and check SHA-256 + index rows |

**`atlas sharepoint backup`**

| Option | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `--full` | Force full crawl ignoring saved delta links |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas sharepoint list-snapshots`**

| Option | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas sharepoint list-versions`**

| Option | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-f, --file <ref>` | File ID or path to look up (required) |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas sharepoint restore`**

| Option | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>` | SharePoint snapshot ID (required) |
| `--target-site <url-or-id>` | Restore to a different site (defaults to original) |
| `--file-filter <paths...>` | Only restore specific files (by ID or path) |
| `-c, --conflict <mode>` | File conflict policy: `replace`, `rename`, or `fail` (default: `rename`) |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas sharepoint save`**

Save decrypted files from a SharePoint snapshot to a local zip archive. The archive preserves the original folder structure from document libraries. Each file is SHA-256 verified after decryption by default.

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 -O ~/Downloads/backup.zip
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --file-filter "/Documents/report.docx"
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 --skip-verify
```

| Option | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>` | SharePoint snapshot ID (required) |
| `--file-filter <paths...>` | Only save specific files (by ID or path) |
| `-O, --output <path>` | Output zip file path (default: auto-generated) |
| `--skip-verify` | Skip SHA-256 integrity checks |
| `-t, --tenant <id>` | Override tenant ID from config |

**`atlas sharepoint verify`**

| Option | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-s, --snapshot <id>` | SharePoint snapshot ID (required) |
| `-t, --tenant <id>` | Override tenant ID from config |

::: tip Permissions
Application permissions `Sites.Read.All` and `Files.Read.All` are required for SharePoint backup and verification. Restore additionally requires `Sites.ReadWrite.All`.
:::

## `atlas storage-check`

Validate immutable backup readiness without running a backup. Reports versioning and Object Lock status.

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

Show storage statistics for the entire bucket or a specific mailbox. Reports object counts and total storage size across data, attachments, and manifest prefixes.

```bash
atlas stats                            # bucket-level overview
atlas stats -m user@company.com        # mailbox-level breakdown
atlas stats --json                     # raw JSON output
```

| Option                  | Description                                |
| ----------------------- | ------------------------------------------ |
| `-m, --mailbox <email>` | Show statistics for a specific mailbox     |
| `--json`                | Output raw JSON instead of formatted table |
| `-t, --tenant <id>`     | Override tenant ID from config             |

The bucket-level overview shows total object counts and storage consumption across all mailboxes. The mailbox breakdown shows per-prefix statistics (data, attachments, manifests) so you can identify which mailboxes consume the most storage. Use `--json` for programmatic consumption in monitoring scripts or dashboards.

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

atlas replicate --status
atlas replicate --status -m user@company.com
atlas replicate --status -s <snapshot-id>
atlas replicate --status --site https://contoso.sharepoint.com/sites/Engineering
```

| Option                       | Description                                           |
| ---------------------------- | ----------------------------------------------------- |
| `-s, --snapshot <id>`        | Replicate a specific snapshot                         |
| `-m, --mailbox <email>`      | Replicate all unreplicated snapshots for a mailbox    |
| `--site <url-or-id>`         | Replicate all unreplicated snapshots for a SharePoint site |
| `--target-endpoint <url>`    | Target S3 endpoint URL                                |
| `--target-access-key <key>`  | Target S3 access key                                  |
| `--target-secret-key <key>`  | Target S3 secret key                                  |
| `--target-region <region>`   | Target S3 region (default: `us-east-1`)               |
| `--target-config <path>`     | Path to JSON file with target S3 credentials          |
| `--status`                   | Show replication status instead of replicating        |
| `-t, --tenant <id>`          | Override tenant ID                                    |

::: tip Target Config File
The target config file is a JSON object with `s3_endpoint`, `s3_access_key`, `s3_secret_key`, and optionally `s3_region` and `target_id`. The encryption passphrase is shared from the main Atlas configuration.
:::

## `atlas rehydrate`

Recover snapshots from a replica to primary storage. This is a disaster recovery operation -- not a bidirectional sync. Snapshots already on primary are skipped.

```bash
atlas rehydrate -s <snapshot-id> \
  --source-endpoint http://offsite:9000 \
  --source-access-key <key> \
  --source-secret-key <secret>

atlas rehydrate -m user@company.com --source-config ./offsite.json
atlas rehydrate --all --source-config ./offsite.json

atlas rehydrate --site https://contoso.sharepoint.com/sites/Engineering --source-config ./offsite.json
atlas rehydrate --site contoso.sharepoint.com,guid,guid -s sp-snap-1735689600000-a1b2c3 --source-config ./offsite.json
```

| Option                       | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `-s, --snapshot <id>`        | Recover a specific snapshot from the replica             |
| `-m, --mailbox <email>`      | Recover all snapshots for a mailbox from the replica     |
| `--site <url-or-id>`         | Recover all SharePoint snapshots for a site from the replica |
| `--all`                      | Recover all mailboxes and snapshots (full tenant DR)     |
| `--source-endpoint <url>`    | Source replica S3 endpoint URL                           |
| `--source-access-key <key>`  | Source replica S3 access key                             |
| `--source-secret-key <key>`  | Source replica S3 secret key                             |
| `--source-region <region>`   | Source replica S3 region (default: `us-east-1`)          |
| `--source-config <path>`     | Path to JSON file with source S3 credentials             |
| `-t, --tenant <id>`          | Override tenant ID                                       |

::: danger Rehydration Is Not Sync
Rehydration copies explicitly selected data from a designated replica to primary. It does not merge, diff, or resolve conflicts. After rehydration, primary resumes as the source of truth. Delta links in recovered manifests may be stale -- Atlas falls back to full sync on the next backup automatically.
:::
