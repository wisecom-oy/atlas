---
description: Back up user OneDrive drives to S3 incrementally, then restore, verify, or export from encrypted snapshots.
---

# OneDrive backup

Atlas backs up a user's OneDrive incrementally: after the first run, each run reads only what changed. Every file is encrypted before it leaves the machine, and each unique file is stored once. A run that changes something records a snapshot, and you restore, verify, or export from those snapshots.

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

`-o` accepts a user's email address or their Microsoft Entra ID object ID. Atlas looks up the object ID for an email address, and stores data under the object ID. Snapshot IDs have the form `od-snap-<milliseconds>-<6-hex>`, and `backup` prints the ID of each snapshot it creates.

## What is backed up

| Item                      | Coverage                                                                  |
| ------------------------- | ------------------------------------------------------------------------- |
| Files                     | Current content of every drive the user owns, each unique file stored once |
| Version history           | Earlier versions Microsoft 365 returns for each file                      |
| Folder structure          | Paths recorded in the snapshot                                            |
| OneNote notebooks         | Section files and table of contents, as ordinary files ([details](#onenote-notebooks)) |
| Moves, renames, deletions | Recorded as changes on the next run                                       |
| Sharing                   | Each file's and folder's own permissions, without link URLs ([details](#sharing)) |

Restores do not recreate file authors, and reapply sharing only when asked. See [what a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

To back up one folder tree instead of the whole drive, pass `--folder /Projects` to `backup`. Changing the folder scope forces a full backup.

### OneNote notebooks

A OneNote notebook is stored as its section files (`.one`) and its table of contents (`.onetoc2`), each backed up byte for byte as an ordinary file. The run reports how many notebooks it found, and warns when a notebook has a failed section, because a table of contents without its sections restores into a notebook that will not open.

Restored sections arrive as ordinary files. Dropping them back into a drive does not rebuild a notebook OneNote will open. Treat notebook restore as recovering the section data, let OneNote import it, and verify the result before relying on it.

## Permissions

Add these application permissions to the Atlas app registration in Microsoft Entra ID, and grant admin consent:

| Permission            | Used for                                    |
| --------------------- | ------------------------------------------- |
| `Files.Read.All`      | Backup, verify, and save                    |
| `Sites.Read.All`      | Backup. Atlas names it with `Files.Read.All` when Microsoft Graph refuses to list a drive |
| `User.Read.All`       | Looking up user email addresses             |
| `Files.ReadWrite.All` | Restore, including sharing                  |

If a permission is missing, the run stops before it touches any files with `MissingGraphPermissionsError` (`ATLAS_AUTH_DENIED`, exit `4`). The message names the HTTP status, the Microsoft Graph error code, and the permissions to grant.

## Commands

Every command takes `-o, --owner <id>` (required) and `-t, --tenant <id>` (defaults to the configured tenant). Snapshot is `-s`. The [CLI reference](./reference/cli.md) lists global flags and exit codes.

### backup

| Flag                   | Description                                               | Default        |
| ---------------------- | --------------------------------------------------------- | -------------- |
| `-o, --owner <id>`     | User email or Entra object ID                             | Required       |
| `--full`               | Ignore the saved sync checkpoint and read the whole drive | `false`        |
| `--folder <path>`      | Back up only this folder and its subfolders               | Whole drive    |
| `--retention-days <n>` | Apply Object Lock retention to stored objects             | Off            |
| `--lock-mode <mode>`   | `governance` or `compliance`; requires `--retention-days` | Not set        |
| `-t, --tenant <id>`    | Tenant identifier                                         | Config default |

```bash
atlas onedrive backup -o user@example.com --folder /Projects --full
```

Each run picks up from a sync checkpoint (a Microsoft Graph delta link) saved by the previous one. See [incremental sync](/operations/delta-sync).

::: warning Object Lock
Object Lock makes stored objects undeletable until the retention period ends. Use `compliance` mode only when no one, including tenant administrators, should be able to shorten it. See [immutability](/operations/immutability).
:::

### restore

| Flag                       | Description                                         | Default                |
| -------------------------- | --------------------------------------------------- | ---------------------- |
| `-o, --owner <id>`         | Source user                                         | Required               |
| `-s, --snapshot <id>`      | Snapshot to restore                                 | Required               |
| `--target-owner <id>`      | Restore into another user's drive                   | Source user            |
| `--destination <path>`     | Folder to restore under; created when missing       | `/Restore-<timestamp>` |
| `--in-place`               | Restore to the original paths                       | `false`                |
| `--name <filename>`        | Rename the restored file; single-file restores only | Original name          |
| `--file-filter <paths...>` | Restore only the given files, by ID or path         | All files              |
| `-c, --conflict <mode>`    | `rename`, `replace`, or `fail`                      | `rename`               |
| `--restore-permissions`    | Reapply captured grants and recreate sharing links, see [Restoring sharing](#restoring-sharing) | `false` |
| `-t, --tenant <id>`        | Tenant identifier                                   | Config default         |

```bash
# Restore everything into a fresh Restore-<timestamp> folder
atlas onedrive restore -o user@example.com -s od-snap-123

# Restore in place and give everyone their access back
atlas onedrive restore -o user@example.com -s od-snap-123 --in-place --restore-permissions

# Restore two files, replacing any that exist at the destination
atlas onedrive restore -o user@example.com -s od-snap-123 \
  --file-filter /Documents/report.docx /Documents/budget.xlsx -c replace
```

`--target-owner` is refused for a snapshot that spans several drives. Restore it to the original owner, or one drive at a time with `--file-filter`.

| Conflict mode      | Behavior                                                       |
| ------------------ | -------------------------------------------------------------- |
| `rename` (default) | Adds a numeric suffix, so existing files are never overwritten |
| `replace`          | Overwrites the existing file                                   |
| `fail`             | Skips the file and logs an error                               |

Restored files keep their original created and modified timestamps. Each file is decrypted and checked against its SHA-256 checksum before upload. A file whose stored object is missing, fails AES-GCM authentication, or does not match the snapshot is reported as a restore error with the reason and is not created. The rest of the snapshot is restored, and the run exits `2`. A wrong passphrase stops the run with exit `5` before anything is written.

To stop a restore safely, see [stopping a run](#stopping-a-run).

### restore-version

Restores earlier versions of a file, or of every file as of a point in time. See [rolling a file back to an earlier version](#rolling-a-file-back-to-an-earlier-version).

| Flag                | Description                                        | Default                |
| ------------------- | -------------------------------------------------- | ---------------------- |
| `-o, --owner <id>`  | Owner                                              | Required               |
| `-f, --file <ref>`  | File ID or path; required with `--version`         | Optional               |
| `--version <id>`    | Exact stored version to restore                    | Optional               |
| `--before <iso>`    | Newest version at or before this instant, per file | Optional               |
| `--path <prefix>`   | Limit a `--before` rollback to one folder          | Whole drive            |
| `--in-place`        | Upload over the original file                      | `false`, writes a copy |
| `-t, --tenant <id>` | Tenant identifier                                  | Config default         |

### save

Writes a snapshot to a local zip archive instead of uploading to Microsoft 365. The archive keeps the folder hierarchy. Files larger than 4 MiB are verified in a first pass and then decrypted as a stream into the archive, so memory use does not grow with file size.

| Flag                       | Description                              | Default        |
| -------------------------- | ---------------------------------------- | -------------- |
| `-o, --owner <id>`         | Owner                                    | Required       |
| `-s, --snapshot <id>`      | Snapshot to save from                    | Required       |
| `--file-filter <paths...>` | Save only the given files, by ID or path | All files      |
| `--output <path>`          | Output zip file path                     | Auto-generated |
| `-y, --yes`                | Overwrite existing output, no prompt     | `false`        |
| `--skip-verify`            | Skip SHA-256 checks while saving         | `false`        |
| `-t, --tenant <id>`        | Tenant identifier                        | Config default |

```bash
atlas onedrive save -o user@example.com -s od-snap-123 --output ~/Downloads/backup.zip
```

If `--output` names an existing file, Atlas asks `Overwrite? [Y/n]` before it contacts Microsoft 365 or reads storage. Answering `n` exits `0` and leaves the file as it was. Pass `-y` to overwrite without the question. The question exists because an earlier export can be the only copy of a snapshot that retention has since removed.

In unattended runs with stdin at EOF, as under cron or systemd with `/dev/null`, no answer is read. The command exits `1` and the existing file is untouched. Pass `-y` in scheduled jobs that overwrite their output.

::: warning Mark-of-the-Web on Windows
On Windows the archive is stamped with Mark-of-the-Web (`Zone.Identifier`, `ZoneId=3`), so extracted Office files open in Protected View and macros stay blocked. Clear the mark once you trust the content:

```powershell
Get-ChildItem -Recurse <dir> | Unblock-File
```

Nothing is written on macOS or Linux. See [exported archives](./reference/cli.md) in the CLI reference.
:::

### verify

Checks a snapshot's integrity without restoring anything.

| Flag                  | Description        | Default        |
| --------------------- | ------------------ | -------------- |
| `-o, --owner <id>`    | Owner              | Required       |
| `-s, --snapshot <id>` | Snapshot to verify | Required       |
| `-t, --tenant <id>`   | Tenant identifier  | Config default |

```bash
atlas onedrive verify -o user@example.com -s od-snap-1735689600000-a1b2c3
```

For each file, Atlas decrypts the stored copy, recomputes its SHA-256 over the plaintext, and compares it with the snapshot using a constant-time comparison. It also confirms the per-file version index has a record for the snapshot. Content is streamed, so memory use does not grow with file size.

Exit code `0` means every checked entry passed. Exit code `1` means a content mismatch or an index inconsistency was found.

### list-snapshots, list-versions, and list-permissions

```bash
atlas onedrive list-snapshots -o user@example.com
atlas onedrive list-versions -o user@example.com -f "/Documents/report.docx"
atlas onedrive list-permissions -o user@example.com
atlas onedrive list-permissions -o user@example.com -s od-snap-123
```

`list-versions` takes `-f, --file <ref>` (a file ID or path, required).

`list-permissions` shows who had access to what at a snapshot, the newest unless `-s` names one. It prints one row per permission: the item's path, its kind (file or folder), the roles, and the grantee or the link's type and scope. It reads the backup alone, so it works when the drive or the user is gone.

### status

```bash
atlas onedrive status -o user@example.com
```

Reports, per drive, the file changes waiting for the next backup and the files in the list of failed files. It reads the sync checkpoint without moving it, so the next backup is unaffected. A drive is up to date only when it has no pending file and no failed file. A Microsoft Graph `401` or `403` exits with code `4`. See the [status columns](/reference/cli#drive-status-columns).

### delete

| Flag                  | Description                                                  | Default        |
| --------------------- | ------------------------------------------------------------ | -------------- |
| `-o, --owner <id>`    | Owner                                                        | Required       |
| `-s, --snapshot <id>` | Delete the newest snapshot instead of all data for the owner | All data       |
| `-y, --yes`           | Skip the confirmation prompt                                 | `false`        |
| `-t, --tenant <id>`   | Tenant identifier                                            | Config default |

```bash
atlas onedrive delete -o user@example.com -s od-snap-123
```

`-s` accepts only the owner's newest snapshot, because each snapshot builds on the ones before it. For an older snapshot Atlas exits with code `11` and deletes nothing. Deleting the newest snapshot also removes the sync checkpoint, so the next backup reads every drive in full and captures again what that snapshot held. See [what `-s` does](/reference/cli#drive-snapshot-delete).

::: danger Deletion is permanent
Deletion erases every version of each object, not just the latest. Objects still protected by Object Lock are reported as retained, separately from failures. See [erasure](/security#erasure). To remove all data for a tenant across every workload, use `atlas delete --purge`.
:::

## Where restored files land

A restore creates `/Restore-<timestamp>` at the drive root and recreates the original folder structure beneath it. A file backed up from `/Projects/2026/Report.docx` restores to `/Restore-2026-08-27T10-15-30/Projects/2026/Report.docx`. Deleting that folder undoes the restore.

A separate folder is the default because the `rename` conflict mode alone would scatter suffixed copies through live content. Use `--in-place` to restore to the original paths, and `--destination` to choose the folder name.

`--name` is rejected when a restore matches more than one file, so pair it with `--file-filter`. Nesting under a restore folder lengthens every path. A file that exceeds OneDrive's path length limit is reported as skipped and does not abort the run.

## Sharing

Atlas records who each file and folder is shared with: direct grants to users and groups, and sharing links. For each it keeps the roles, the grantee, a link's type and scope, its expiry, and whether it had a password. A link's URL is never stored, see [Sharing links are stored without their URLs](/security#sharing-links-are-stored-without-their-urls).

- Only an item's own permissions are recorded. Access inherited from a parent folder is implied by the folder's entry.
- A change to sharing alone is picked up on the next backup without downloading the file again.
- A folder appears in a snapshot only while it has permissions of its own.

::: details How sharing is read
Atlas reads permissions only for items Microsoft Graph reports as shared, 20 items per `$batch` request. A file whose sharing changed and whose content did not is recorded as change type `permissions_changed` and reuses the stored content of its previous entry. See [the cost of capturing sharing](/security#the-cost-of-capturing-sharing).
:::

### Restoring sharing

```bash
atlas onedrive restore -o user@example.com -s od-snap-123 --in-place --restore-permissions
```

Without `--restore-permissions` a restore applies no permission, and the summary reports how many it left out. Sharing is opt-in because a restore into another user's drive or a restore folder would otherwise share the content with the original audience again.

With the flag, Atlas reapplies each permission to the restored item:

| Permission                      | How it is restored                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Direct grant to a user or group | Granted again, with no invitation email and sign-in required                            |
| Organization or anonymous link  | A new link with the same type and scope, and the expiry when it is still in the future. The URL is new |
| Specific-people link            | A new link with the same type and scope, shared with the recorded people                |
| Owner grant                     | Not reapplied. The target drive's owner already holds it                                |

A permission that cannot be reapplied is listed with its reason. It does not fail the restore or change the exit code. Typical reasons:

- The grantee no longer exists.
- The link expired.
- The link was password-protected. The password cannot be read back.
- Tenant policy forbids that kind of link.
- The grant was to a SharePoint site group.

::: details Microsoft Graph calls used
Direct grants use `invite`, by object ID and then by address, with `sendInvitation: false` and `requireSignIn: true`. Links use `createLink`.
:::

### First backup after upgrading

Sync checkpoints saved before sharing was captured do not mark which items are shared. The first backup after upgrading detects this and lists each drive in full once.

- Unchanged files are not downloaded again.
- Files deleted since the last run are still recorded as deleted.
- The run reads the permissions of every shared item, so expect it to take longer than an incremental backup.

## Rolling a file back to an earlier version

Version restore brings back an earlier version of one file, or the state of a folder as of a point in time, from the stored version history.

```bash
# List versions of one file
atlas onedrive list-versions -o user@example.com -f "/Documents/report.docx"

# Restore one version as a copy beside the original
atlas onedrive restore-version -o user@example.com -f "/Documents/report.docx" --version 3.0

# Roll every file under /Projects back to 10 March 2026
atlas onedrive restore-version -o user@example.com \
  --before 2026-03-10T00:00:00Z --path "/Projects"
```

- Content comes from the verified backup, not from the live file.
- By default Atlas writes `report (restored <timestamp>).docx` beside the original and leaves the live file untouched. `--in-place` overwrites the original.
- A file with no version before the cutoff is reported as skipped.
- Version restore works only within the same tenant and drive. To put files into another user's drive, use `restore --target-owner`, which restores snapshot state, not history.

## Reading the result

### Snapshot health

Each backup ends with a health status:

| Status      | Meaning                                                                         | Exit code |
| ----------- | ------------------------------------------------------------------------------- | --------- |
| `HEALTHY`   | Every file's current content was backed up. The snapshot is safe to rely on.    | `0`       |
| `UNHEALTHY` | At least one file failed, or a drive-level error occurred. The run is partial.  | `2`       |
| `UNHEALTHY` | The newest snapshot manifest cannot be read, and nothing else went wrong        | `9`       |

A hard failure that aborts the run exits `1`. For an unreadable manifest, the run names it; see [damaged manifests](/troubleshooting#damaged-manifests-and-version-indexes). Warnings, such as advisory OneNote notes, print as `[!]` lines and leave the exit code at `0`.

### No snapshot is created

A run creates a snapshot only when something changed. Two outcomes end without one, and they mean different things:

| `summary.noSnapshotReason` | Meaning                                                       | Recovery point                | CLI prints |
| -------------------------- | ------------------------------------------------------------- | ----------------------------- | ---------- |
| `no_changes`               | The drive has content, and nothing changed since the last run | An earlier snapshot covers it | `No OneDrive changes detected. Snapshot skipped.` |
| `no_content`               | The drive holds nothing to protect                            | None                          | `No OneDrive content found. Nothing was backed up and no snapshot exists.` |

The field is absent when a snapshot was created, and absent when the run was interrupted or ended UNHEALTHY. In those cases check `errors` and `healthy`. A run that stored nothing because it was interrupted, or because every changed file failed, exits `2` and prints:

```text
No snapshot created: the run was interrupted or every change failed.
```

## When a file cannot be backed up

One file that cannot be read never stops the rest of the drive. Atlas keeps the files that succeeded, moves the sync checkpoint forward, and records the failure.

| Situation                                   | What Atlas does                                                      | What you do |
| ------------------------------------------- | -------------------------------------------------------------------- | ----------- |
| Download fails                              | Records the file in the list of failed files and retries it next run | Nothing, unless it reaches 5 attempts |
| Download link expired                       | Fetches a fresh link and continues                                   | Nothing |
| Malware quarantine                          | Skips the download and reports the file as permanently skipped by service policy | Resolve the file in Microsoft 365 if it should be backed up |
| Sensitivity label, IRM, or retention rule   | Records a permanent failure for that file, with the Graph error code | Review the policy on that file |
| Application permission missing (`403`)      | Stops the run                                                        | Grant the permission, see [Permissions](#permissions) |
| Any other unrecognised `403`                | Fails that one file, not the run                                     | Check the Graph error code in the output |
| File changes size during the download       | Reads the file again at its current size                             | Nothing, unless it keeps changing |
| Earlier version cannot be downloaded        | Marks the run UNHEALTHY, or counts the version as `unavailable`      | See [version failures](#version-failures) |

### Failed files

Each failed file is retried at the start of the next run, before new changes:

- If the file downloads, it is stored and the failure clears.
- If the file no longer exists, the failure is dropped.
- If it fails again, its attempt count increases.

After 5 attempts the file is no longer retried, but every run reports it as `PERMANENTLY SKIPPED after 5 attempts`. The run stays UNHEALTHY until the file is fixed or removed in the source.

Some failures are not the file's fault and do not use an attempt: an expired download link, a file interrupted by Ctrl+C, and a malware quarantine, which retries cannot change.

### Expired download links

Microsoft 365 gives Atlas a time-limited download link for each file. On a long run a link can expire before Atlas reaches the file or while it is reading it. Atlas fetches a fresh link and continues, resuming large files where they stopped. If the file still cannot be read, it is recorded as not backed up and retried on the next run without using an attempt.

::: details How expired links are handled, by file size
A `401` or `403` from the download link means it expired.

| File size                | Link at download start          | When the link expires mid-transfer                                                       |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Up to 4 MiB              | Link from the change listing    | Fetch a fresh link once, retry the whole file, then fall back to the Graph `/content` endpoint |
| Over 4 MiB, under 64 MiB | Link from the change listing    | Fetch a fresh link once, restart from byte zero, then fall back to `/content`            |
| 64 MiB and larger        | Fresh link, one Graph request   | Fetch a fresh link and resume at the 4 MiB range that failed                             |

For files of 64 MiB and larger, a run can refresh the link any number of times, as long as each fresh link delivers at least one more range. If three fresh links in a row expire before any new range arrives, Atlas records the file as not backed up, without counting an attempt. A Graph refusal while fetching a fresh link is handled like the other `403` cases: a missing grant stops the run, and a service refusal is recorded as permanent. The fresh link costs one Graph request per file of 64 MiB or more.
:::

### Version failures

| Situation                                                        | Result                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Unexpected failure: throttling, `403 accessDenied`, transient fault | Error. The run is UNHEALTHY.                                           |
| Microsoft 365 reports the version gone (`404` or `410`, purged by retention policy) | Counted as `unavailable`. Health is unaffected.        |
| Download delivers fewer or more bytes than listed                | Fails with `DownloadIntegrityError` before anything is stored. The run is UNHEALTHY. |

Only the HTTP status of the response decides between error and `unavailable`. An error whose message text happens to contain "404" or "Not Found" is an ordinary failure. A failed version is downloaded again by the next backup that picks up a change to the file.

### Files that change size

Every download is checked against the size the change listing reported. A file can change between its listing and its download, and SharePoint, which stores OneDrive content, can rewrite a file on its first download without creating a version. When the size differs, Atlas reads the file's details once more and downloads it again at its current size, and the snapshot records that size.

A file whose size still changes fails with `DownloadIntegrityError`, is recorded as a failed file, and leaves the run UNHEALTHY. After 5 failed attempts it is reported as `PERMANENTLY SKIPPED`.

::: details Size check details
Each range of a chunked download also carries the file's total length in its `Content-Range` header, which is checked too. The refresh costs one item read per mismatching file, and a file gets at most one refresh per run. A truncated transfer or a wrong byte range is never refreshed and fails at once.
:::

## Stopping a run

**Backup.** Ctrl+C stops a backup at once, including in the middle of a download, during a Microsoft Graph call, and during a retry or throttle wait. A file interrupted this way is not recorded as failed, so it keeps its 5 attempts for the next run. Rerunning the backup is safe.

**Restore.** The first Ctrl+C stops the restore at once, but lets a write already sent to Microsoft 365 finish, because Microsoft 365 may already have committed it. The command prints the files restored so far and exits `2`. A file stopped before it was written is not reported as failed. `restore-version` behaves the same way.

::: warning Second Ctrl+C during a restore
A second Ctrl+C exits at once with status `130` and skips the safe stop. A file whose upload was in flight may or may not exist. Check the destination before retrying, especially with `--in-place`.
:::

::: details Which writes finish after Ctrl+C
A file up to 4 MiB is uploaded in one request. A larger file is created by the final chunk of its upload session, so that request finishes and the file counts as restored if Microsoft 365 accepted it. A larger file stopped before its final chunk is not created, and its upload session is deleted.
:::

See [reliability](/operations/reliability) for retries and what is safe to rerun.

## Limits

| Area                 | Limit                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Downloads            | Up to 4 MiB in one request; 4 to 64 MiB in 4 MiB ranges; 64 MiB and larger streamed through a staging upload |
| Uploads on restore   | Up to 4 MiB in one request; larger files in a resumable upload session in 10 MiB chunks           |
| Throttling           | Retried with backoff, see below                                                                    |
| Path length          | A restore folder adds path depth. Files over OneDrive's path length limit are skipped and reported. |
| Scope                | File authors are not restored. Sharing is restored only with `--restore-permissions`               |

When Microsoft 365 throttles requests or has a transient fault, Atlas waits and retries. See [Graph rate limits](/operations/graph-rate-limits) for request budgets.

::: details Retry and throttling details
- Graph `429`, transient `500`, `502`, `503` and `504` responses, and dropped connections are retried with backoff, up to 5 times per range for chunked downloads.
- A file up to 4 MiB is read from its download link in one request. A `429` there is retried up to 3 times against the same link before Atlas falls back to the Graph `/content` endpoint.
- A `Retry-After` on a download is honoured in either form, seconds or an HTTP date, and capped at one hour.
:::

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

// Incremental backup, then a forced full backup
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

// Status: reads the sync checkpoint without moving it
const status = await atlas.onedrive.checkStatus('user@example.com');
console.log(`Up to date: ${status.isUpToDate}, pending: ${status.totalPendingChanges}`);

// Erase all data for a user
const deletion = await atlas.onedrive.deleteOwnerData('user@example.com');
console.log(`Deleted: ${deletion.deletedObjects} objects`);
```

Other methods: `restoreVersion`, `listSnapshots`, `listFileVersions`, `listPermissions`, and `deleteSnapshot`. See the [SDK reference](./reference/sdk.md).

## See also

- [CLI reference](./reference/cli.md)
- [Programmatic SDK](./reference/sdk.md)
- [SharePoint backup](./sharepoint-backup.md)
- [Security](/security)
