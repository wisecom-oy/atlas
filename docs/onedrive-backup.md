# OneDrive backup

Atlas backs up user OneDrive drives incrementally with Microsoft Graph delta queries. Each file is encrypted before it leaves the machine and stored once per unique content. Every run that changes something records a snapshot, and you restore, verify, or export from those snapshots.

For SharePoint document libraries, see [SharePoint backup](./sharepoint-backup.md).

## Quick start

```bash
# Back up a user, incrementally
atlas onedrive backup -o user@example.com

# List snapshots, then check one
atlas onedrive list-snapshots -o user@example.com
atlas onedrive verify -o user@example.com -s od-snap-1735689600000-a1b2c3

# Restore a snapshot into a new Restore-<timestamp> folder on the drive
atlas onedrive restore -o user@example.com -s od-snap-1735689600000-a1b2c3
```

`-o` accepts a user's email address or their Microsoft Entra ID object ID. Storage keys always use the object ID, so the CLI and SDK resolve email addresses first. Snapshot IDs have the form `od-snap-<milliseconds>-<6-hex>`, and `backup` prints the ID of each snapshot it creates.

## What is backed up

| Item | Coverage |
| --- | --- |
| Files | Current content of every drive the user owns, deduplicated by SHA-256 |
| Version history | Earlier versions Graph returns for each file |
| Folder structure | Paths recorded in the snapshot manifest |
| OneNote notebooks | Section files and table of contents, stored as ordinary files ([details](#onenote-notebooks)) |
| Moves, renames, deletions | Recorded as changes on the next run |

Sharing permissions are not captured, and restores do not recreate file authors. See [what a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

To back up one folder tree instead of the whole drive, pass `--folder /Projects` to `backup`. Changing the folder scope forces a full crawl.

## Permissions

Add these application permissions to the Atlas app registration in Microsoft Entra ID, and grant admin consent:

| Permission | Used for |
| --- | --- |
| `Files.Read.All` | Backup, verify, and save |
| `User.Read.All` | Resolving user email addresses to object IDs |
| `Files.ReadWrite.All` | Restore only |

If a permission is missing, the run stops before it touches any files and names the missing scope, for example `Missing Microsoft Graph application permissions for OneDrive: Files.Read.All.`

## Commands

### backup

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | User email or Entra object ID | Required |
| `--full` | Ignore saved delta state and crawl the whole drive | `false` |
| `--folder <path>` | Back up only this folder and its subfolders | Whole drive |
| `--retention-days <n>` | Apply Object Lock retention to stored objects | Off |
| `--lock-mode <mode>` | `governance` or `compliance`; requires `--retention-days` | Not set |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas onedrive backup -o user@example.com --folder /Projects --full
```

Object Lock makes stored objects undeletable until the retention period ends. Use `compliance` mode only when no one, including tenant administrators, should be able to shorten it.

### restore

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | Source user | Required |
| `-s, --snapshot <id>` | Snapshot to restore | Required |
| `--target-owner <id>` | Restore into another user's drive. Refused for snapshots that span several drives; restore those to the original owner, or one drive at a time with `--file-filter` | Source user |
| `--destination <path>` | Folder to restore under; created when missing | `/Restore-<timestamp>` |
| `--in-place` | Restore to the original paths | `false` |
| `--name <filename>` | Rename the restored file; single-file restores only | Original name |
| `--file-filter <paths...>` | Restore only the given files, by ID or path | All files |
| `-c, --conflict <mode>` | `rename`, `replace`, or `fail` | `rename` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
# Restore everything into a fresh Restore-<timestamp> folder
atlas onedrive restore -o user@example.com -s od-snap-123

# Restore two files, replacing any that exist at the destination
atlas onedrive restore -o user@example.com -s od-snap-123 \
  --file-filter /Documents/report.docx /Documents/budget.xlsx -c replace
```

#### Conflict modes

| Mode | Behavior |
| --- | --- |
| `rename` (default) | Adds a numeric suffix, so existing files are never overwritten |
| `replace` | Overwrites the existing file |
| `fail` | Skips the file and logs an error |

Restored files keep their original created and modified timestamps. Each file is decrypted and checked against its SHA-256 checksum before upload. A file whose stored bytes do not match the manifest is reported as a restore error, is not created, and makes the run exit non-zero.

### restore-version

Restores earlier versions of a file, or of every file as of a point in time. See [rolling a file back to an earlier version](#rolling-a-file-back-to-an-earlier-version).

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | Owner | Required |
| `-f, --file <ref>` | File ID or path; required with `--version` | Optional |
| `--version <id>` | Exact stored version to restore | Optional |
| `--before <iso>` | Newest version at or before this instant, per file | Optional |
| `--path <prefix>` | Limit a `--before` rollback to one folder | Whole drive |
| `--in-place` | Upload over the original file | `false`, writes a copy |
| `-t, --tenant <id>` | Tenant identifier | Config default |

### save

Writes a zip archive instead of uploading to Graph. The archive keeps the folder hierarchy, and files larger than 4 MiB are decrypted as a stream.

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | Owner | Required |
| `-s, --snapshot <id>` | Snapshot to save from | Required |
| `--file-filter <paths...>` | Save only the given files, by ID or path | All files |
| `--output <path>` | Output zip file path | Auto-generated |
| `--skip-verify` | Skip SHA-256 checks while saving | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas onedrive save -o user@example.com -s od-snap-123 --output ~/Downloads/backup.zip
```

::: warning Mark-of-the-Web on Windows
On Windows the archive is stamped with Mark-of-the-Web (`Zone.Identifier`, `ZoneId=3`), so extracted Office files open in Protected View and macros stay blocked. Clear the mark once you trust the content:

```powershell
Get-ChildItem -Recurse <dir> | Unblock-File
```

Nothing is written on macOS or Linux. See [exported archives](./reference/cli.md) in the CLI reference.
:::

### verify

Checks a snapshot's integrity without restoring anything. For each entry, Atlas decrypts the stored blob, recomputes its SHA-256 over the plaintext, and compares the digest with the manifest using a constant-time comparison. It also confirms the per-file index has a record for the snapshot. Content is streamed, so verification memory does not grow with file size.

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | Owner | Required |
| `-s, --snapshot <id>` | Snapshot to verify | Required |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas onedrive verify -o user@example.com -s od-snap-1735689600000-a1b2c3
```

### list-snapshots and list-versions

```bash
atlas onedrive list-snapshots -o user@example.com
atlas onedrive list-versions -o user@example.com -f "/Documents/report.docx"
```

`list-versions` takes `-f, --file <ref>` (a file ID or path, required).

### status

Reports whether the owner's backup is up to date, using a Graph delta peek. The peek reads the saved delta state without advancing it, so the next backup is unaffected.

```bash
atlas onedrive status -o user@example.com
```

### delete

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | Owner | Required |
| `-s, --snapshot <id>` | Delete one snapshot instead of all data for the owner | All data |
| `-y, --yes` | Skip the confirmation prompt | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas onedrive delete -o user@example.com -s od-snap-123
```

Deletion erases every version of each object, not just the latest. Objects still protected by Object Lock are reported as retained, separately from failures. See [erasure](/security#erasure). To remove all data for a tenant across every workload, use `atlas delete --purge`.

## Where restored files land

A restore creates `/Restore-<timestamp>` at the drive root and recreates the original folder structure beneath it. A file backed up from `/Projects/2026/Report.docx` restores to `/Restore-2026-08-27T10-15-30/Projects/2026/Report.docx`. Deleting that folder undoes the restore.

The default is a restore root because the `rename` conflict mode alone leaves suffixed copies scattered through live content. Use `--in-place` to restore to the original paths. Use `--destination` to choose the folder name.

`--name` is rejected when a restore resolves to more than one file. Pair it with `--file-filter`. Nesting the original structure under a restore root lengthens every path. A file that exceeds OneDrive's path length limit is reported as a skipped item and does not abort the run.

## Rolling a file back to an earlier version

Version restore brings back an earlier version of one file, or the state of a folder as of a point in time, using the stored version history.

```bash
# List versions of one file
atlas onedrive list-versions -o user@example.com -f "/Documents/report.docx"

# Restore one version as a copy beside the original
atlas onedrive restore-version -o user@example.com -f "/Documents/report.docx" --version 3.0

# Roll every file under /Projects back to 10 March 2026
atlas onedrive restore-version -o user@example.com \
  --before 2026-03-10T00:00:00Z --path "/Projects"
```

- Bytes come from the verified snapshot, not from the live file.
- The default writes `report (restored <timestamp>).docx` beside the original. The live file is not touched.
- `--in-place` overwrites the original file.
- A file with no version before the cutoff is reported as skipped rather than silently ignored.
- Version restore works only within the same tenant and drive. A file restored into another drive has no version chain to join, so use `restore --target-owner` for that case. That restores snapshot state, not history.

## Snapshot health

Each backup ends with a health status:

- **HEALTHY.** Every file's primary content was backed up. The snapshot and delta state are safe to rely on.
- **UNHEALTHY.** At least one file failed, or a library-level error occurred. The run exits with code `2` for a partial run. A hard failure that aborts the run exits with code `1`.

Warnings, such as advisory OneNote notes, print as `[!]` lines and leave the exit code at `0`.

### Failed items

A file that cannot be downloaded does not stop the rest of the drive. Atlas keeps the files that succeeded, advances the delta state, and records the failure. On the next run, each recorded failure is retried before new changes are processed:

- If the file downloads, it is stored and the failure clears.
- If the file no longer exists, the failure is dropped.
- If it fails again, the attempt count increases.

After 5 attempts the file is no longer retried, but it is reported on every run as `PERMANENTLY SKIPPED after 5 attempts`. The run stays UNHEALTHY until the file is fixed or removed in the source.

### Quarantined and protected files

- **Malware quarantine.** Quarantined files are detected from delta metadata before a download is attempted. They are reported as permanently skipped by service policy and do not use the 5-attempt budget, because retries cannot change a policy decision.
- **403 responses.** A missing application permission stops the run immediately. A protection or policy state (for example a sensitivity label, IRM, or retention rule) is recorded against that one file as permanent, with the Graph error code. An expired pre-authenticated download URL is re-resolved and retried once. Any other unrecognized 403 code costs one file, not the whole run.

### Version failures

A version that fails to download for an unexpected reason (throttling, `403 accessDenied`, or a transient fault) is an error and makes the run UNHEALTHY. A version that Graph reports as gone (`404` or `410`, purged by retention policy) is counted as `unavailable` and does not affect health.

## No snapshot is created

A run creates a snapshot only when something changed. Two outcomes end without one, and they mean different things:

| `summary.noSnapshotReason` | Meaning | Recovery point |
| --- | --- | --- |
| `no_changes` | The drive has content, and nothing changed since the last run | An earlier snapshot covers it |
| `no_content` | The drive holds nothing to protect | None |

The field is absent when a snapshot was created, and absent when the run was interrupted or ended UNHEALTHY. In those cases, check `errors` and `healthy` instead. The CLI prints `No OneDrive changes detected. Snapshot skipped.` for `no_changes`.

## OneNote notebooks

A OneNote notebook is stored as its section files (`.one`) and its table of contents (`.onetoc2`). Each is backed up byte-for-byte as an ordinary file. The run also reports how many notebooks were found and warns when a notebook has a failed section, because a table of contents without its sections restores into a notebook that will not open.

Restored sections are ordinary files. Dropping them back into a drive does not reconstruct a notebook that OneNote will open, so treat notebook restore as recovering the section data, then let OneNote import it and verify the result.

## Limits

- **Uploads.** Files up to 4 MiB are uploaded in one request. Larger files use a resumable upload session in 10 MiB chunks.
- **Throttling.** Graph `429` and transient `5xx` responses are retried with backoff.
- **Path length.** Restores under a root add path depth. Files over OneDrive's path length limit are skipped and reported.
- **Scope.** Permissions and authors are not restored.

## SDK usage

The SDK exposes the same operations on `atlas.onedrive`. Options and results use camelCase. Owner arguments accept an email address or an object ID.

```ts
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: '<tenant-id>',
  clientId: '<client-id>',
  clientSecret: '<client-secret>',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: '<access-key>',
  s3SecretKey: '<secret-key>',
  encryptionPassphrase: '<passphrase>',
});

// Incremental backup, then a forced full crawl
const result = await atlas.onedrive.backup('user@example.com');
console.log(`Snapshot: ${result.snapshot?.snapshotId}`);

const full = await atlas.onedrive.backup('user@example.com', { forceFull: true });

// Verify a snapshot
const verify = await atlas.onedrive.verify('user@example.com', 'od-snap-123');
if (verify.failedFileIds.length > 0) {
  console.error('Failed files:', verify.failedFileIds);
}

// Restore into a Restore-<timestamp> folder
const restored = await atlas.onedrive.restore('user@example.com', {
  snapshotId: 'od-snap-123',
  conflictBehavior: 'rename',
});
console.log(`Restored: ${restored.filesRestored} files`);

// Save to a local zip archive
await atlas.onedrive.save('user@example.com', {
  snapshotId: 'od-snap-123',
  outputPath: 'onedrive-backup.zip',
});

// Status: fast delta peek, does not advance cursors
const status = await atlas.onedrive.checkStatus('user@example.com');
console.log(`Up to date: ${status.isUpToDate}, pending: ${status.totalPendingChanges}`);

// Erase all data for a user
const deletion = await atlas.onedrive.deleteOwnerData('user@example.com');
console.log(`Deleted: ${deletion.deletedObjects} objects`);
```

Other methods: `restoreVersion`, `listSnapshots`, `listFileVersions`, `deleteSnapshot`, and the replication methods below.

## Replication

Replication copies encrypted snapshot data to a second S3-compatible target without decrypting it. The replica includes blobs, manifests, version indexes, and delta state, so incremental backups resume after a rehydrate.

```bash
# Replicate one snapshot, or every snapshot that has not been replicated
atlas replicate -o user@example.com -s od-snap-123 --target-config ./offsite.json
atlas replicate -o user@example.com --target-config ./offsite.json

# Recover all of an owner's snapshots, or one snapshot
atlas rehydrate -o user@example.com --source-config ./offsite.json
atlas rehydrate -o user@example.com -s od-snap-123 --source-config ./offsite.json
```

```ts
const offsite = createStorageTarget({ /* ... */ });

await atlas.onedrive.replicateAll('user@example.com', [offsite]);
await atlas.onedrive.rehydrateOwner('user@example.com', offsite);
```

See [replication](./operations/replication.md) for target setup and disaster recovery.

## See also

- [CLI reference](./reference/cli.md)
- [Programmatic SDK](./reference/sdk.md)
- [SharePoint backup](./sharepoint-backup.md)
- [Security](/security)
