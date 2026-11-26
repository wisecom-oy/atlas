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
| Folder colours            | Each folder's colour, captured but not restored ([details](#folder-colours)) |

Restores do not recreate file authors or folder colours, and reapply sharing only when asked. See [what a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

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

An owner who has never opened OneDrive has no drive. Microsoft Graph answers the drive listing with `404 ResourceNotFound` ("User's mysite not found."), and the run ends at once with `NotFoundError` (`ATLAS_NOT_FOUND`, exit `7`), see [no drive is provisioned](/troubleshooting#onedrive-no-drive-is-provisioned). Any other `404` or `400` on the listing is read again, 3 reads in about 6 s. One that persists for an owner who exists ends the run with `GraphUnavailableError` (`ATLAS_GRAPH_UNAVAILABLE`, exit `3`) before anything is written. See [The first read of a run](/operations/reliability#first-reads-of-a-run).

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

Each run picks up from a sync checkpoint (a Microsoft Graph delta link) saved by the previous one. A run that reads a drive in full records a deletion for each file that is gone, but only once the drive's listing reached its end. See [incremental sync](/operations/delta-sync) and [Deletions found by a full read](/operations/delta-sync#drive-full-read-deletions).

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

`list-permissions` shows who had access to what at a snapshot, the newest unless `-s` names one. It prints one row per permission: the item's path, its kind (file or folder), the roles, and the grantee or the link's type and scope. A second table lists each coloured folder. It reads the backup alone, so it works when the drive or the user is gone.

### status

```bash
atlas onedrive status -o user@example.com
```

Reports, per drive, the file changes waiting for the next backup and the files in the list of failed files. It reads the sync checkpoint without moving it, so the next backup is unaffected. A drive is up to date only when it has no pending file and no failed file. A Microsoft Graph `401` or `403` exits with code `4`. A drive that could not be checked shows `peek failed` and the command exits `3` when Microsoft Graph was throttling or unavailable through the retries, or `2` for any other failure. See the [status columns](/reference/cli#drive-status-columns).

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
- A folder appears in a snapshot only while it has permissions or a [colour](#folder-colours) of its own.

::: details How sharing is read
Atlas reads permissions only for items Microsoft Graph reports as shared, 20 items per `$batch` request. A file whose sharing changed and whose content did not is recorded as change type `permissions_changed` and reuses the stored content of its previous entry. See [the cost of capturing sharing](/security#the-cost-of-capturing-sharing).
:::

### When permissions cannot be read

If Microsoft Graph refuses the permission read of a shared item, for example with `404` or `423`, the item is added to the drive's [list of failed files](#failed-files) with the reason `Permission read failed: Microsoft Graph did not return the sharing permissions`. The run is UNHEALTHY and exits `2`.

- A file whose content changed is still stored. Its entry keeps the permissions of its previous entry, so the snapshot does not show the file as unshared.
- A change to sharing alone writes no entry in that run.
- The next run reads the item again by its ID and reads its permissions, without the item having to change. Once the read succeeds, a changed sharing is recorded as `permissions_changed` and the failure clears.

The change listing does not present an unchanged item again, so without the list a sharing change whose read failed would never be recorded. A failed read uses one of the item's 5 attempts. An item deleted after the change listing was read answers `404` on its re-read and is dropped by the rule in [A listed file that answers not found](#a-listed-file-that-answers-not-found). When the whole read fails because Microsoft Graph is down, the run stops with exit `3` instead, see [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle).

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
- Files deleted since the last run are still recorded as deleted. A listing that Microsoft Graph ends early fails the drive and records no deletions. See [Deletions found by a full read](/operations/delta-sync#drive-full-read-deletions).
- The run reads the permissions of every shared item, so expect it to take longer than an incremental backup.

## Folder colours

```bash
atlas onedrive list-permissions -o user@example.com
```

Atlas records the colour of each coloured folder, and `list-permissions` shows it in a second table. Restore does not set it: a restored folder takes the destination's default colour.

- A folder's colour is stored in the `_ColorHex`, `_ColorTag`, and `_Emoji` columns of its list item, not on the folder itself. Atlas records the values that are set. `_ColorHex` holds the palette position the web UI chose, such as `6`, not a hex value.
- Changing a colour is picked up on the next backup. Removing one is recorded as well.
- A folder appears in a snapshot only while it has a colour or permissions of its own. A folder with both has one entry.
- A colour that cannot be read is logged, and the folder keeps the colour last recorded. It never fails the backup of the files around it.

::: details How colours are read
The change listing never carries these columns, so Atlas reads them separately for every folder a backup receives, 20 folders per `$batch` request. A new entry is written only when the colour differs from the last one recorded. See [the cost of capturing folder colours](/security#the-cost-of-capturing-folder-colours).
:::

### Why restore cannot set colours

Microsoft Graph refuses every write to these columns with `403 accessDenied` (`Field '_ColorHex' is read-only`), even with `Files.ReadWrite.All` and `Sites.ReadWrite.All`, so Atlas does not attempt one. The restore summary reports `Folder colours not restored` with a count. That line does not change the exit code. Writing colours needs the SharePoint REST API with certificate authentication, tracked in [#778](https://github.com/wisecom-oy/atlas/issues/778).

### Colours after upgrading

The one-time full listing described in [First backup after upgrading](#first-backup-after-upgrading) reads every folder's colour. A drive whose sync checkpoint was already past that listing records a folder's colour the next time the folder comes back in the change listing, which happens when the folder or anything inside it changes. Atlas does not list such drives in full again to pick up colours sooner.

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
| Download fails because Microsoft 365 is down or throttling, or the connection drops | Records the file in the list of failed files and retries it next run, without using an attempt | Nothing |
| Download fails for any other reason         | Records the file in the list of failed files and retries it next run | Nothing, unless it reaches 5 attempts |
| Download link expired                       | Fetches a fresh link and continues                                   | Nothing |
| Malware quarantine                          | Skips the download and reports the file as permanently skipped by service policy | Resolve the file in Microsoft 365 if it should be backed up |
| `403` with a protection code, listed below  | Records a permanent failure for that file, with the Graph error code | Review the policy on that file |
| Application permission missing (`403 accessDenied` or `403 ErrorAccessDenied`) | Stops the run                           | Grant the permission, see [Permissions](#permissions) |
| Any other `403`, including one with no code | Fails that file for this run and retries it next run, up to 5 attempts | Check the Graph error code in the run output |
| File changes size during the download       | Reads the file again at its current size                             | Nothing, unless it keeps changing |
| Earlier version cannot be downloaded        | Marks the run UNHEALTHY, or counts the version as `unavailable`      | See [version failures](#version-failures) |
| File larger than 312.5 GiB                  | Refuses it before downloading or uploading anything, and records a permanent failure that names S3's 10,000-part limit | Nothing. Microsoft 365 caps a file at 250 GB, so this needs a larger file than the service allows. See [object size limits](/self-hosting/storage#object-size-limits) |

A `403` is permanent on the first occurrence only for these Graph error codes:

| Code                         | Meaning                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `malwareDetected`            | Microsoft 365 quarantined the content as malware                     |
| `fileDoubleKeyEncrypted`     | A sensitivity label encrypts the file with Double Key Encryption     |
| `fileDecryptionNotSupported` | A sensitivity label encrypts the file in a way the service cannot decrypt |

Microsoft does not document which code a download returns for an IRM or retention block. A refusal with any code outside this list is retried like an ordinary failure, and reported as `PERMANENTLY SKIPPED after 5 attempts` once the budget is spent. Atlas does not treat an unknown code as permanent, because one transient or misread `403` would then hide the file from every later backup.

### Failed files

Each failed file is retried at the start of the next run, before new changes:

- If the file downloads, it is stored and the failure clears.
- If it was listed because its permissions could not be read, they are read again, and the failure clears once they are. See [When permissions cannot be read](#when-permissions-cannot-be-read).
- If the file was deleted, the failure is dropped. A `404` on the re-read is not enough on its own. See [A listed file that answers not found](#a-listed-file-that-answers-not-found).
- If it fails again, its attempt count increases, unless the failure is outside the file.

Only a failure that belongs to the file uses one of its 5 attempts. A scheduled backup can run five times inside one Microsoft 365 incident, so counting outage failures would skip every file the incident touched.

| Failure, on the download or on the re-read of a listed file | Uses an attempt |
| ----------------------------------------------------------- | --------------- |
| Throttling (`429`, or `503` with `Retry-After`) once the retries are spent | No |
| Microsoft Graph `500`, `502`, `503`, or `504` once the retries are spent | No |
| Connection reset or refused, DNS failure, or a timed-out transfer, including a download host that is down | No |
| Download link expired | No |
| Run interrupted by Ctrl+C | No |
| `404` or `itemNotFound` on the re-read of a listed file | No |
| Downloaded body of the wrong length or range, or a file that keeps changing size | Yes |
| Any other `4xx`, such as `400` or a `403` with an unrecognised code | Yes |
| Malware quarantine, or a `403` with a protection code | Permanent at once, never retried |
| File larger than 312.5 GiB, which one S3 multipart upload cannot hold | Permanent at once, never retried, reported as `PERMANENTLY SKIPPED by service policy, not retried` |
| Storage failure while writing the file, at any size: a full disk or quota, an S3 `5xx` once the retries are spent, or an endpoint that never answers | No. The drive fails instead and the file is not listed, see below |

A file that has failed only for reasons outside it is reported as `will retry (no attempt counted yet)`, and the run stays UNHEALTHY with exit code `2`, so an outage stays visible. Such a file is retried on every run until it backs up. When a Microsoft Graph call spends its whole retry budget, the run also stops there and exits `3`, keeping the file listed with its attempts unchanged. See [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle).

A storage failure is the backend's, not the file's. It fails the drive like a missing permission does: the drive keeps its sync checkpoint, so the next run reads the file again from the change listing, and the failure is reported as the drive's error with exit code `2`. When storage stays full or down, the run's own commit fails as well and the command exits with that storage error's code, as listed in [Exit codes](/reference/cli#exit-codes).

After 5 attempts the file is no longer retried, but every run reports it as `PERMANENTLY SKIPPED after 5 attempts`. The run stays UNHEALTHY until the file is fixed or removed in the source. To fetch it again once the cause is fixed, run a full backup:

```bash
atlas onedrive backup -o user@example.com --full
```

A full backup ignores the saved sync checkpoint and its list of failed files, so every file is read again and a listed file starts with a fresh budget. It downloads all content again, but content already in storage is not uploaded twice. Editing the file in Microsoft 365 also gets it read once more, because the change listing presents changed files again.

#### A listed file that answers not found

A file on the failed list stays listed when Microsoft Graph answers its re-read with `404` or `itemNotFound`. It keeps its attempts, the run stays UNHEALTHY with exit code `2`, and it is reported with the reason `Graph answered "not found" when re-reading the file`. The next run reads it again, and once Graph answers normally it is stored.

A single `404` is not proof of deletion. Graph returns it during service incidents and from replica lag, and Atlas does not retry a `404`. The drive's sync checkpoint has already moved past the file, and the change listing (delta) never re-presents an unchanged file, so dropping it on one `404` would leave it out of every later snapshot while the run reported HEALTHY.

The failure is dropped as a deletion in either of these cases:

| Evidence | When the failure is dropped |
| -------- | --------------------------- |
| The change listing reports the file as deleted | In that run. This is how a real deletion normally clears. |
| The re-read answers `404` on 3 runs in a row, spanning at least 24 hours | On the run that meets both conditions |

Both conditions are needed for the second case. A run count alone would let a one-hour incident clear a file on a 15-minute schedule, and a time span alone would decide on two answers a day apart. Any other outcome for the file, such as a failed download, starts the count again. The second case covers a deletion that the change listing never reported, such as one hidden by a full re-read of the drive after a delta reset, so a deleted file does not stay listed indefinitely.

### Expired download links

Microsoft 365 gives Atlas a time-limited download link for each file. On a long run a link can expire before Atlas reaches the file or while it is reading it. Atlas fetches a fresh link and continues, resuming large files where they stopped. If the file still cannot be read, it is recorded as not backed up and retried on the next run without using an attempt.

::: details How expired links are handled, by file size
A `401` or `403` from the download link means it expired.

| File size                | Link at download start          | When the link expires mid-transfer                                                       |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Up to 4 MiB              | Link from the change listing    | Fetch a fresh link once, retry the whole file, then fall back to the Graph `/content` endpoint |
| Over 4 MiB, under 64 MiB | Link from the change listing    | Fetch a fresh link once, restart from byte zero, then fall back to `/content`            |
| 64 MiB and larger        | Fresh link, one Graph request   | Fetch a fresh link and resume at the 4 MiB range that failed                             |

For files of 64 MiB and larger, a run can refresh the link any number of times, as long as each fresh link delivers at least one more range. If three fresh links in a row expire before any new range arrives, Atlas records the file as not backed up, without counting an attempt. A Graph refusal while fetching a fresh link is handled like the other `403` cases: a missing grant stops the run, a protection code is recorded as permanent, and any other `403` fails the file for that run. The fresh link costs one Graph request per file of 64 MiB or more.
:::

### Version failures

| Situation | Result |
| --- | --- |
| Unexpected failure: throttling, `403 accessDenied`, transient fault | Error. The run is UNHEALTHY. |
| `404` or `410`, and the version is no longer in the file's version list (purged by retention policy) | Counted as `unavailable`. Health is unaffected. |
| `404` or `410`, and the version is still listed | Error. The run is UNHEALTHY. Counted as `unavailable` once the answer repeats on 3 runs in a row spanning at least 24 hours |
| Download delivers fewer or more bytes than listed | Fails with `DownloadIntegrityError` before anything is stored. The run is UNHEALTHY. |
| Version larger than 312.5 GiB | Counted as `unavailable` without being downloaded, and never retried. Health is unaffected. |

Only the HTTP status of the response decides between error and `unavailable`. An error whose message text happens to contain "404" or "Not Found" is an ordinary failure. A `404` is not proof the version is gone: Microsoft Graph returns one during incidents, and the run listed the version moments earlier. Atlas therefore reads the version list once more for that file before counting a version as purged, which costs one extra request per file and only when a `404` or `410` occurs.

A failed version stops the file's [watermark](/operations/delta-sync#file-version-capture-onedrive-and-sharepoint), so it is downloaded again, along with every newer version, by the next backup that picks up the file. Newer versions already stored deduplicate.

The same holds when a run stores a file's content and then stops before capturing its versions: the drive fails, the version listing fails, or Ctrl+C ends the run. The cursor records the file as owing versions, and the next run that sees it captures them even though the content is already stored. A file whose versions were all captured costs no version request when its content deduplicates, for example on a `--full` run.

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
| File size            | 312.5 GiB per file or version, above Microsoft 365's 250 GB. See [object size limits](/self-hosting/storage#object-size-limits) |
| Uploads on restore   | Up to 4 MiB in one request; larger files in a resumable upload session in 10 MiB chunks           |
| Throttling           | Retried with backoff, see below                                                                    |
| Path length          | A restore folder adds path depth. Files over OneDrive's path length limit are skipped and reported. |
| Scope                | File authors and folder colours are not restored. Sharing is restored only with `--restore-permissions` |

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
