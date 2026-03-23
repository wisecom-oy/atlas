# Usage Guide

Complete reference for the Atlas CLI commands and programmatic SDK.

## Table of Contents

- [CLI Reference](#cli-reference)
  - [atlas backup](#atlas-backup)
  - [atlas status](#atlas-status)
  - [atlas mailboxes](#atlas-mailboxes)
  - [atlas storage-check](#atlas-storage-check)
  - [atlas list](#atlas-list)
  - [atlas read](#atlas-read)
  - [atlas verify](#atlas-verify)
  - [atlas restore](#atlas-restore)
  - [atlas save](#atlas-save)
  - [atlas delete](#atlas-delete)
  - [atlas stats](#atlas-stats)
- [Programmatic SDK](#programmatic-sdk)
  - [Installation](#installation)
  - [Creating an instance](#creating-an-instance)
  - [Available methods](#available-methods)
  - [Batch processing](#batch-processing)

---

## CLI Reference

### `atlas backup`

Back up mailboxes from M365 tenant to object storage. When a mailbox is specified with `-m`, backs up that single mailbox with a per-folder progress dashboard. When no mailbox is specified, discovers all Exchange-licensed mailboxes in the tenant and backs them up in parallel with a tenant-level dashboard showing concurrent worker progress.

**Single mailbox:**

```bash
atlas backup -m user@company.com                      # incremental backup
atlas backup -m user@company.com --full                # force full sync (ignore delta state)
atlas backup -m user@company.com -f Inbox Sent         # specific folders only
atlas backup -m user@company.com -P 50                 # larger page size for fewer API round-trips
atlas backup -m user@company.com --retention-days 30 --lock-mode governance
atlas backup -m user@company.com --retention-days 365 --lock-mode compliance
atlas backup -t <tenant-id> -m user@company.com        # explicit tenant
```

**Full tenant (all licensed mailboxes):**

```bash
atlas backup                                           # back up all licensed mailboxes (4 concurrent)
atlas backup -C 8                                      # increase parallel workers to 8
atlas backup --full                                    # force full sync for all mailboxes
```

| Option                   | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `-m, --mailbox <id>`     | Specific mailbox to back up (backs up all licensed if omitted)    |
| `-f, --folder <name...>` | Filter to specific folder(s) by display name                      |
| `--full`                 | Ignore saved delta links, run full enumeration                    |
| `-P, --page-size <n>`    | Graph API page size per delta request (1-100, default 10)         |
| `-C, --concurrency <n>`  | Parallel mailbox count for tenant backup (default 4)              |
| `--retention-days <n>`   | Apply Object Lock retention for `n` days                          |
| `--lock-mode <mode>`     | Object Lock mode (`governance` or `compliance`)                   |
| `--require-immutability` | Fail if immutability cannot be enforced                           |
| `-t, --tenant <id>`      | Override tenant ID from config                                    |

> **Tenant-wide mode:** When no `-m` flag is given, Atlas discovers all Exchange Online-licensed mailboxes via Microsoft Graph, then runs up to `-C` concurrent backup workers. A compact dashboard shows each active worker's mailbox, folder progress, and overall completion. The first Ctrl+C gracefully finishes active mailboxes; a second Ctrl+C force-quits immediately.

> **Page size tuning:** The `--page-size` flag controls how many messages are requested per Graph API delta page via the `Prefer: odata.maxpagesize` header. This is a *hint* -- the server may return fewer items when response payloads are large (e.g. messages with heavy HTML bodies or many inline images). Lower values reduce memory pressure and allow partial progress to be saved more frequently during interrupts. Higher values reduce HTTP round-trips but increase per-page processing time. The default of 10 is a conservative starting point that works well across most mailbox sizes; increase if you have many small messages and want fewer HTTP round-trips.

> **Immutability behavior:** `--retention-days` makes the backup immutable-requested. Atlas resolves retention to an internal UTC `retain_until`, probes bucket capability (versioning + Object Lock), and fails fast when unsupported instead of silently downgrading to mutable writes.

### `atlas status`

Check whether a mailbox backup is up to date by peeking at Microsoft Graph delta state. This does **not** run a backup -- it only queries the delta endpoint with the saved delta links from the latest manifest to detect pending changes. The delta token is not consumed, so subsequent backups still resume from the same checkpoint.

```bash
atlas status -m user@company.com                       # check backup freshness
atlas status -m user@company.com -t <tenant-id>        # explicit tenant
```

| Option                  | Description                               |
| ----------------------- | ----------------------------------------- |
| `-m, --mailbox <email>` | Mailbox to check (required)               |
| `-t, --tenant <id>`     | Override tenant ID from config             |

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

### `atlas mailboxes`

List tenant mailboxes directly from Microsoft Graph (live data, not from the backup catalog). Shows each mailbox's email address, display name, Exchange Online license status, account status, creation date, and optionally mailbox size.

```bash
atlas mailboxes                                        # list all mailboxes
atlas mailboxes --licensed-only                        # only Exchange-licensed mailboxes
atlas mailboxes -t <tenant-id>                         # explicit tenant
```

| Option              | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `--licensed-only`   | Only show mailboxes with an active Exchange Online license         |
| `-t, --tenant <id>` | Override tenant ID from config                                    |

> **Mailbox size** requires the `Reports.Read.All` Graph API permission. If the permission is not granted, the Size column is omitted without error.

### `atlas storage-check`

Validate immutable backup readiness without running a backup. Reports versioning and Object Lock status.

```bash
atlas storage-check
atlas storage-check --lock-mode governance --retention-days 30
atlas storage-check --lock-mode compliance --retention-days 365
```

| Option                 | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `--lock-mode <mode>`   | Planned Object Lock mode (`governance` or `compliance`) |
| `--retention-days <n>` | Planned retention period in days                       |
| `-t, --tenant <id>`    | Override tenant ID                                     |

### `atlas list`

Browse backed-up data at three zoom levels. Subjects are hidden by default for data protection.

```bash
atlas list                              # all mailboxes with summary stats
atlas list -m user@company.com          # all snapshots for a mailbox
atlas list -s <snapshot-id>             # messages inside a snapshot (first 50)
atlas list -s <snapshot-id> --all       # all messages
atlas list -s <snapshot-id> -S          # reveal email subjects
```

| Option                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `-m, --mailbox <email>` | Show snapshots for this mailbox                               |
| `-s, --snapshot <id>`   | Show messages inside this snapshot                            |
| `--all`                 | Show all messages (default caps at 50)                        |
| `-S, --subjects`        | Reveal email subjects (hidden by default for data protection) |
| `-t, --tenant <id>`     | Override tenant ID                                            |

### `atlas read`

Decrypt and display a single backed-up message. Messages are referenced by their `#` index from `atlas list` output. If the message has attachments, their metadata (name, MIME type, size) is listed below the body.

```bash
atlas read -s <snapshot-id> --message 34        # formatted view (by index)
atlas read -s <snapshot-id> --message 34 --raw  # full JSON
```

| Option                | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `-s, --snapshot <id>` | Snapshot containing the message                           |
| `--message <ref>`     | Message `#` from `atlas list`, or full Graph message ID   |
| `--raw`               | Output full JSON blob instead of formatted headers + body |
| `-t, --tenant <id>`   | Override tenant ID                                        |

### `atlas verify`

Verify integrity of a backup snapshot. Downloads every object, decrypts, recomputes SHA-256, and compares against the manifest checksum.

```bash
atlas verify -s <snapshot-id>
```

### `atlas restore`

Restore emails from backup to an M365 mailbox. Two modes of operation:

**Snapshot mode** -- restore from a specific snapshot:

```bash
atlas restore -s <snapshot-id>                          # full snapshot to original mailbox
atlas restore -s <snapshot-id> -f Inbox                 # restore one folder only
atlas restore -s <snapshot-id> --message 42             # restore a single message by index
atlas restore -s <snapshot-id> -m target@company.com    # restore to a different mailbox
```

**Mailbox mode** -- aggregate all snapshots for a mailbox, deduplicate, and restore:

```bash
atlas restore -m user@company.com                                    # full mailbox restore
atlas restore -m user@company.com -f Inbox                           # only the Inbox folder
atlas restore -m user@company.com --start-date 2026-01-01            # from Jan 1 onward
atlas restore -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30  # date range
atlas restore -m user@company.com -T other@company.com               # cross-mailbox restore
atlas restore -m user@company.com -T other@company.com -f Inbox      # cross-mailbox + folder
```

| Option                      | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `-s, --snapshot <id>`       | Restore from a specific snapshot                              |
| `-m, --mailbox <email>`     | Restore from all snapshots for this mailbox                   |
| `-T, --target <email>`      | Target mailbox for cross-mailbox restore (defaults to source) |
| `-f, --folder <name>`       | Restore only messages from this folder                        |
| `--message <ref>`           | Restore a single message by `#` index from `atlas list`       |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date               |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date              |
| `-t, --tenant <id>`         | Override tenant ID                                            |

Either `--snapshot` or `--mailbox` is required. When using mailbox mode, entries are deduplicated across snapshots (newest version of each message wins). Cross-mailbox restores preserve the original folder names from the source mailbox.

Restored messages retain their original received/sent timestamps, appear as received mail (not drafts), and include all backed-up attachments. Large attachments (>3 MB) use Graph upload sessions with chunked transfer. A multi-line dashboard shows restore progress with per-folder status and ETA.

### `atlas save`

Export backed-up emails as standard `.eml` files (RFC 5322, same format Outlook uses for email downloads) in a compressed zip archive. Messages include all backed-up attachments embedded as MIME parts. By default, every message and attachment is SHA-256 verified after decryption before being written to the archive.

**Snapshot mode** -- save from a specific snapshot:

```bash
atlas save -s <snapshot-id>                              # full snapshot
atlas save -s <snapshot-id> -f Inbox                     # save one folder only
atlas save -s <snapshot-id> --message 42                 # save a single message
atlas save -s <snapshot-id> -o ~/Downloads/backup.zip    # custom output path
atlas save -s <snapshot-id> --skip-verify                # skip integrity checks
```

**Mailbox mode** -- aggregate all snapshots for a mailbox:

```bash
atlas save -m user@company.com                                           # full mailbox
atlas save -m user@company.com -f Inbox                                  # only Inbox
atlas save -m user@company.com --start-date 2026-01-01                   # from Jan 1 onward
atlas save -m user@company.com --start-date 2026-01-01 --end-date 2026-06-30  # date range
```

| Option                      | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `-s, --snapshot <id>`       | Save from a specific snapshot                                   |
| `-m, --mailbox <email>`     | Save from all snapshots for this mailbox                        |
| `-f, --folder <name>`       | Save only messages from this folder                             |
| `--message <ref>`           | Save a single message by `#` index from `atlas list`            |
| `--start-date <YYYY-MM-DD>` | Include snapshots created on or after this date                 |
| `--end-date <YYYY-MM-DD>`   | Include snapshots created on or before this date                |
| `-o, --output <path>`       | Output file path (default: `Restore-<timestamp>.zip`)           |
| `--skip-verify`             | Skip SHA-256 integrity checks (faster on low-power systems)     |
| `-t, --tenant <id>`         | Override tenant ID                                              |

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

### `atlas delete`

Delete backed-up data with confirmation prompt.

```bash
atlas delete -m user@company.com        # delete all data + manifests for a mailbox
atlas delete -s <snapshot-id>           # delete one snapshot manifest (data retained)
atlas delete --purge                    # delete EVERYTHING in the tenant bucket
atlas delete --purge -y                 # skip confirmation prompt
```

| Option                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `-m, --mailbox <email>` | Delete all data, attachments, and manifests for a mailbox      |
| `-s, --snapshot <id>`   | Delete a single snapshot manifest (data objects retained)       |
| `--purge`               | Delete all data, manifests, and encryption keys (irreversible) |
| `-y, --yes`             | Skip confirmation prompt                                       |
| `-t, --tenant <id>`     | Override tenant ID                                             |

When Object Lock retention protects objects, delete commands return non-zero and report retained items separately from generic failures. In versioned buckets, Atlas attempts version-level deletion and reports immutable leftovers transparently.

### `atlas stats`

Show storage statistics for the entire bucket or a specific mailbox.

```bash
atlas stats                                            # bucket-level overview
atlas stats -m user@company.com                        # mailbox-level breakdown
atlas stats --json                                     # raw JSON output
```

| Option                  | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `-m, --mailbox <email>` | Show statistics for a specific mailbox           |
| `--json`                | Output raw JSON instead of formatted table       |
| `-t, --tenant <id>`     | Override tenant ID from config                   |

---

## Programmatic SDK

Atlas can be used as a typed library in other Node.js applications. The SDK is available as a separate subpath import.

### Installation

```bash
npm add m365-atlas
```

### Creating an instance

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({
  tenantId: 'your-azure-tenant-id',
  clientId: 'app-client-id',
  clientSecret: 'app-client-secret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'minioadmin',
  s3SecretKey: 'minioadmin',
  encryptionPassphrase: 'my-secret-passphrase',
});
```

All config is explicit -- no environment variables or config files are read. The tenant is bound at creation time, so every method operates within that tenant scope.

The SDK uses standard ES6 camelCase naming. All methods are async and return Promises. Backup and restore operations are mailbox-scoped for controlled batching in job runners.

### Available methods

```typescript
// backup a single mailbox (long-running)
const result = await atlas.backupMailbox('user@company.com', { force_full: true });

// list backed-up mailboxes
const mailboxes = await atlas.listMailboxes();

// list snapshots for a mailbox
const snapshots = await atlas.listSnapshots('user@company.com');

// verify snapshot integrity
const verification = await atlas.verifySnapshot('snapshot-id');

// restore from a specific snapshot (long-running)
const restore = await atlas.restoreSnapshot('snapshot-id', { folder_name: 'Inbox' });

// restore all snapshots for a mailbox (long-running)
const fullRestore = await atlas.restoreMailbox('user@company.com');

// save snapshot as EML zip archive
const save = await atlas.saveSnapshot('snapshot-id', {
  folder_name: 'Inbox',
  output_path: 'backup.zip',
});

// save all snapshots for a mailbox as EML zip archive
const fullSave = await atlas.saveMailbox('user@company.com', {
  output_path: 'full-backup.zip',
  skip_integrity_check: true,  // optional: skip SHA-256 verification
});

// read a single message
const message = await atlas.readMessage('snapshot-id', 'msg-42');

// delete mailbox data
const deletion = await atlas.deleteMailboxData('user@company.com');

// check if a mailbox backup is current (fast delta peek)
const status = await atlas.checkMailboxStatus('user@company.com');
console.log(status.is_up_to_date, status.total_pending_changes);

// check storage readiness
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retention_days: 30 });
```

#### Save options

The `saveSnapshot` and `saveMailbox` methods accept the following options:

| Option                 | Type      | Description                                                  |
| ---------------------- | --------- | ------------------------------------------------------------ |
| `folder_name`          | `string`  | Save only messages from this folder                          |
| `message_ref`          | `string`  | Save a single message by index or ID                         |
| `start_date`           | `Date`    | Include snapshots on or after this date                      |
| `end_date`             | `Date`    | Include snapshots on or before this date                     |
| `output_path`          | `string`  | Output zip file path (default: `Restore-<timestamp>.zip`)    |
| `skip_integrity_check` | `boolean` | Skip SHA-256 verification (default: `false`)                 |

Both methods return a `SaveResult`:

```typescript
interface SaveResult {
  snapshot_id: string;
  saved_count: number;
  attachment_count: number;
  error_count: number;
  errors: string[];
  output_path: string;
  total_bytes: number;
  integrity_failures: string[];
}
```

### Batch processing

For backing up multiple mailboxes, the recommended approach is the CLI's built-in tenant-wide mode (`atlas backup` without `-m`), which handles parallel workers with rate limiting and a live dashboard.

For SDK usage, create one instance and iterate sequentially. Each backup/restore/save operation makes hundreds or thousands of Microsoft Graph API requests internally, so running mailboxes in parallel with `Promise.all` would overwhelm the API and trigger throttling (HTTP 429). Sequential loops ensure reliable throughput:

```typescript
const mailboxIds = ['alice@company.com', 'bob@company.com', 'carol@company.com'];

for (const mailboxId of mailboxIds) {
  const result = await atlas.backupMailbox(mailboxId);
  console.log(`${mailboxId}: snapshot ${result.snapshot.id}`);
}
```

The SDK exports its own types via `m365-atlas/sdk`. Domain types, port interfaces, and result types are available from the root `m365-atlas` import for advanced use cases. Status-related types (`MailboxStatusResult`, `FolderStatus`) are also exported from `m365-atlas/sdk`.
