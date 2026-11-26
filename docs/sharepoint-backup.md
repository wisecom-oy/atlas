---
description: Back up SharePoint document libraries to S3 incrementally, then restore, verify, or export from encrypted snapshots.
---

# SharePoint backup

Atlas backs up the document libraries of a SharePoint site incrementally: after the first run, each run reads only what changed. One run covers every document library in the site. Every file is encrypted before it leaves the machine, and each unique file is stored once. A run that changes something records a snapshot, and you restore, verify, or export from those snapshots.

For per-user drives, see [OneDrive backup](./onedrive-backup.md).

## Quick start

```bash
# Find the site
atlas sharepoint list-sites

# Back up a site by URL, incrementally
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering

# Force a full backup, ignoring the saved sync checkpoint
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --full

# Verify a snapshot
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering \
  -s sp-snap-1735689600000-a1b2c3
```

`--site` accepts a site URL or a Microsoft Graph site ID. The ID can include the hostname (`contoso.sharepoint.com,<site-guid>,<web-guid>`) or omit it (`<site-guid>,<web-guid>`). Snapshot IDs have the form `sp-snap-<milliseconds>-<6-hex>`, and `backup` prints the ID of each snapshot it creates.

## What is backed up

| Item                            | Coverage                                                                |
| ------------------------------- | ----------------------------------------------------------------------- |
| Files in every document library | Current content, each unique file stored once within the site           |
| Version history                 | Earlier versions Microsoft 365 returns for each file                    |
| Library and folder paths        | Recorded in the snapshot                                                |
| OneNote notebooks               | Section files and table of contents, as ordinary files ([details](#onenote-notebooks)) |
| Subsites                        | Only with `--include-subsites`, one snapshot per subsite                |
| Moves, renames, deletions       | Recorded as changes on the next run                                     |
| Sharing                         | Each file's and folder's own permissions, without link URLs ([details](#sharing)) |
| Folder colours                  | Each folder's colour, captured but not restored ([details](#folder-colours)) |

Site and library permissions are not captured. Restores do not recreate file authors or folder colours, and reapply sharing only when asked. See [what a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

Sites that belong to SharePoint Embedded apps are not backed up. See [SharePoint Embedded containers](#sharepoint-embedded-containers).

### OneNote notebooks

A OneNote notebook is stored as its section files (`.one`) and its table of contents (`.onetoc2`), each backed up byte for byte as an ordinary file. The run reports how many notebooks it found, and warns when a notebook is captured incompletely, because a table of contents without its sections restores into a notebook that will not open.

Restored sections arrive as ordinary files. Dropping them back into a library does not rebuild a notebook OneNote will open. Treat notebook restore as recovering the section data, let OneNote import it, and verify the result before relying on it.

## Permissions

Add these application permissions to the Atlas app registration in Microsoft Entra ID, and grant admin consent:

| Permission            | Used for                                          |
| --------------------- | ------------------------------------------------- |
| `Sites.Read.All`      | Listing sites and reading library metadata        |
| `Files.Read.All`      | Reading file content for backup, verify, and save |
| `Sites.ReadWrite.All` | Restore, including sharing                        |

If a permission is missing, the run stops before it touches any files with `MissingGraphPermissionsError` (`ATLAS_AUTH_DENIED`, exit `4`). The message names the HTTP status, the Microsoft Graph error code, and the permissions to grant:

```text
Microsoft Graph returned HTTP 403 accessDenied for site <site-id> and for the tenant's root site. The app registration needs the SharePoint application permissions Sites.Read.All with admin consent, or a Sites.Selected grant on this site.
```

If the app's credentials work but Microsoft 365 refuses this one site, the run fails with `GraphAccessRefusedError` (`ATLAS_ACCESS_REFUSED`, exit `4`) instead, and other sites are unaffected. An app that relies on `Sites.Selected` grants can also see this error when the refused site lacks its own grant, and the message names that remedy. See [SharePoint: site refused while the root site is readable](/troubleshooting#sharepoint-site-refused-while-the-root-site-is-readable).

::: details How Atlas tells a missing grant from a refused site
Microsoft Graph answers both with the same `403 accessDenied`. After a listing call is refused, Atlas makes one request, `GET /sites/root?$select=id`. If the app can read the tenant's root site, its credentials work and the refusal is about this site alone. An app on `Sites.Selected` grants can read the root site only if it was granted it. The answer is reused for 10 minutes per Graph client, so a run that meets several refused sites checks once.
:::

## SharePoint Embedded containers

Apps built on SharePoint Embedded, among them several Microsoft apps, store their files in container sites under `https://contoso.sharepoint.com/contentstorage/`. They appear in the tenant's site search, but Microsoft Graph refuses them to an app that holds only `Sites` permissions: they need `FileStorageContainer.Selected` and a grant from the app that owns the container type. Atlas does not request that permission and does not back these sites up.

Atlas lists them rather than hiding them, so a coverage report still shows they exist:

- `atlas sharepoint list-sites` shows them with the kind `container (not backed up)`.
- `atlas.sharepoint.listSites()` returns them with `kind: 'file_storage_container'`. Every other site has `kind: 'site'`.
- `isFileStorageContainerSite(webUrl)` applies the same rule to a URL from your own site discovery.

Leave them out of scheduled runs. A backup of one fails at once with `GraphAccessRefusedError`, and retrying returns the same answer. When the site was given by URL, the error's `reason` is `file_storage_container`. When it was given by site ID, `reason` is `access_refused`, because Microsoft Graph also refuses the lookup that would reveal the URL.

## Commands

Every command except `list-sites` takes `--site <url-or-id>` (required), and every command takes `-t, --tenant <id>` (defaults to the configured tenant). Snapshot is `-s`, since `-s` is not used for the site. The [CLI reference](./reference/cli.md) lists global flags and exit codes.

### list-sites

```bash
atlas sharepoint list-sites
```

Lists every site the tenant's site search returns, with its ID, name, kind, and URL. The kind is `site`, or `container (not backed up)` for a [SharePoint Embedded container](#sharepoint-embedded-containers), and a final line counts the containers. Takes only `-t, --tenant <id>`. If Microsoft Graph refuses the search with `403`, the command fails with `MissingGraphPermissionsError` (`ATLAS_AUTH_DENIED`, exit `4`) naming `Sites.Read.All`, because the search covers the whole tenant rather than one site.

### backup

| Flag                   | Description                                                    | Default        |
| ---------------------- | -------------------------------------------------------------- | -------------- |
| `--site <url-or-id>`   | Site URL or Graph site ID                                      | Required       |
| `--full`               | Ignore the saved sync checkpoint and read every library        | `false`        |
| `--include-subsites`   | Also back up every subsite beneath the site, one snapshot each | `false`        |
| `--retention-days <n>` | Apply Object Lock retention to stored objects                  | Off            |
| `--lock-mode <mode>`   | `governance` or `compliance`; requires `--retention-days`      | Not set        |
| `-t, --tenant <id>`    | Tenant identifier                                              | Config default |

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --include-subsites
```

Each run picks up from a sync checkpoint (a Microsoft Graph delta link) saved by the previous one. Each library keeps its own checkpoint. A run that reads a library in full records a deletion for each file that is gone, but only once the library's listing reached its end. See [incremental sync](/operations/delta-sync) and [Deletions found by a full read](/operations/delta-sync#drive-full-read-deletions).

::: warning Object Lock
Object Lock makes stored objects undeletable until the retention period ends. Use `compliance` mode only when no one, including tenant administrators, should be able to shorten it. See [immutability](/operations/immutability).
:::

### restore

| Flag                        | Description                                         | Default                |
| --------------------------- | --------------------------------------------------- | ---------------------- |
| `--site <url-or-id>`        | Source site                                         | Required               |
| `-s, --snapshot <id>`       | Snapshot to restore                                 | Required               |
| `--target-site <url-or-id>` | Restore into a different site                       | Source site            |
| `--destination <path>`      | Folder to restore under; created when missing       | `/Restore-<timestamp>` |
| `--in-place`                | Restore to the original paths                       | `false`                |
| `--name <filename>`         | Rename the restored file; single-file restores only | Original name          |
| `--file-filter <paths...>`  | Restore only the given files, by ID or path         | All files              |
| `-c, --conflict <mode>`     | `rename`, `replace`, or `fail`                      | `rename`               |
| `--restore-permissions`     | Reapply captured grants and recreate sharing links, see [Sharing](#sharing) | `false` |
| `-t, --tenant <id>`         | Tenant identifier                                   | Config default         |

```bash
# Restore everything into a fresh Restore-<timestamp> folder in each library
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123

# Restore into a different site
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --target-site https://contoso.sharepoint.com/sites/Staging

# Restore in place with the files' and folders' own sharing
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --in-place --restore-permissions

# Restore two files, replacing any that exist at the destination
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --file-filter /Documents/report.docx /Documents/budget.xlsx -c replace
```

For how `--target-site` picks a library, see [where a cross-site restore lands](#where-a-cross-site-restore-lands).

| Conflict mode      | Behavior                                                       |
| ------------------ | -------------------------------------------------------------- |
| `rename` (default) | Adds a numeric suffix, so existing files are never overwritten |
| `replace`          | Overwrites the existing file                                   |
| `fail`             | Skips the file and logs an error                               |

Restored files keep their original created and modified timestamps. Each file is decrypted and checked against its SHA-256 checksum before upload. A file whose stored object is missing, fails AES-GCM authentication, or does not match the snapshot is reported as a restore error with the reason and is not created. The rest of the snapshot is restored, and the run exits `2`. A wrong passphrase stops the run with exit `5` before anything is written.

A refusal that every later write would meet stops the restore at once with exit `4`: an `AuthError` such as a revoked credential, or a `403 accessDenied` on a folder create or upload, reported as `MissingGraphPermissionsError` naming `Sites.ReadWrite.All`. Files restored before it stay at the destination and are logged with their count. Any other failure, including a `403` with another code, fails only its own file.

To stop a restore safely, see [stopping a run](#stopping-a-run).

### restore-version

Restores earlier versions of a file, or of every file as of a point in time. See [rolling a file back to an earlier version](#rolling-a-file-back-to-an-earlier-version).

| Flag                 | Description                                        | Default                |
| -------------------- | -------------------------------------------------- | ---------------------- |
| `--site <url-or-id>` | Site                                               | Required               |
| `-f, --file <ref>`   | File ID or path; required with `--version`         | Optional               |
| `--version <id>`     | Exact stored version to restore                    | Optional               |
| `--before <iso>`     | Newest version at or before this instant, per file | Optional               |
| `--path <prefix>`    | Limit a `--before` rollback to one folder          | Whole site             |
| `--in-place`         | Upload over the original file                      | `false`, writes a copy |
| `-t, --tenant <id>`  | Tenant identifier                                  | Config default         |

### save

Writes a snapshot to a local zip archive instead of uploading to Microsoft 365. The archive keeps the library folder hierarchy. Files larger than 4 MiB are verified in a first pass and then decrypted as a stream into the archive, so memory use does not grow with file size.

| Flag                       | Description                              | Default        |
| -------------------------- | ---------------------------------------- | -------------- |
| `--site <url-or-id>`       | Site                                     | Required       |
| `-s, --snapshot <id>`      | Snapshot to save from                    | Required       |
| `--file-filter <paths...>` | Save only the given files, by ID or path | All files      |
| `--output <path>`          | Output zip file path                     | Auto-generated |
| `-y, --yes`                | Overwrite existing output, no prompt     | `false`        |
| `--skip-verify`            | Skip SHA-256 checks while saving         | `false`        |
| `-t, --tenant <id>`        | Tenant identifier                        | Config default |

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --output ~/Downloads/backup.zip
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
| `--site <url-or-id>`  | Site               | Required       |
| `-s, --snapshot <id>` | Snapshot to verify | Required       |
| `-t, --tenant <id>`   | Tenant identifier  | Config default |

```bash
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
```

For each file, Atlas decrypts the stored copy, recomputes its SHA-256 over the plaintext, and compares it with the snapshot using a constant-time comparison. It also confirms the per-file version index has a record for the snapshot. Content is streamed, so memory use does not grow with file size.

Exit code `0` means every checked entry passed. Exit code `1` means a content mismatch or an index inconsistency was found.

### list-snapshots, list-versions, and list-permissions

```bash
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering \
  -f "/Shared Documents/report.docx"
```

`list-versions` takes `-f, --file <ref>` (a file ID or path, required).

```bash
atlas sharepoint list-permissions --site https://contoso.sharepoint.com/sites/Engineering
```

`list-permissions` shows who had access to which file or folder at a snapshot, the newest unless `-s` names one, and the colour of each coloured folder. It reads the backup alone.

### status

```bash
atlas sharepoint status --site https://contoso.sharepoint.com/sites/Engineering
```

Reports, per library, the file changes waiting for the next backup and the files in the list of failed files. It reads the sync checkpoint without moving it, so the next backup is unaffected. A library is up to date only when it has no pending file and no failed file, so a site with files still waiting for a retry is not reported as current. A Microsoft Graph `401` or `403` exits with code `4`. A library that could not be checked shows `peek failed` and the command exits `3` when Microsoft Graph was throttling or unavailable through the retries, or `2` for any other failure. See the [status columns](/reference/cli#drive-status-columns).

### delete

| Flag                  | Description                                                 | Default        |
| --------------------- | ----------------------------------------------------------- | -------------- |
| `--site <url-or-id>`  | Site                                                        | Required       |
| `-s, --snapshot <id>` | Delete the newest snapshot instead of all data for the site | All data       |
| `-y, --yes`           | Skip the confirmation prompt                                | `false`        |
| `-t, --tenant <id>`   | Tenant identifier                                           | Config default |

```bash
atlas sharepoint delete --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
```

`-s` accepts only the site's newest snapshot, because each snapshot builds on the ones before it. For an older snapshot Atlas exits with code `11` and deletes nothing. Deleting the newest snapshot also removes the sync checkpoint, so the next backup reads every library in full and captures again what that snapshot held. See [what `-s` does](/reference/cli#drive-snapshot-delete).

::: danger Deletion is permanent
Deletion erases every version of each object, not just the latest. Objects still protected by Object Lock are reported as retained, separately from failures. See [erasure](/security#erasure). To remove all data for a tenant across every workload, use `atlas delete --purge`.
:::

## Where restored files land

A restore creates `Restore-<timestamp>` in each destination library and recreates the original folder structure beneath it. A file backed up from `/Reports/2026/Report.docx` restores to `/Restore-2026-08-27T10-15-30/Reports/2026/Report.docx`. Deleting that folder undoes the restore.

A separate folder is the default because the `rename` conflict mode alone would scatter suffixed copies through live library content. Use `--in-place` to restore to the original paths, and `--destination` to choose the folder name. With `--in-place`, each file returns to the library it came from, using the `drive_id` stored in the snapshot.

`--name` is rejected when a restore matches more than one file, so pair it with `--file-filter`. Nesting under a restore folder lengthens every path. A file that exceeds SharePoint's path length limit is reported as skipped and does not abort the run.

## Where a cross-site restore lands

Each file in a snapshot records the library it came from, by its `drive_id`. That ID belongs to the source site, so a restore with `--target-site` picks a library in the target site for each file:

1. **Same library name.** The target library with the same name, compared case-insensitively after Unicode NFC normalization and trimming whitespace. If two target libraries share the name, the restore fails rather than picking one.
2. **The only library.** Used only when the snapshot came from a single library and the target site has one library. Snapshots from several libraries are never folded into a single destination library.
3. **Neither.** The file is refused, the candidate libraries are named, and the run exits non-zero. Atlas never guesses a production library.

If the target site has no document libraries, the restore fails before uploading anything.

::: warning Snapshots taken before 2.1.0-beta
Older snapshots do not record library names, so rule 1 cannot apply. Such a snapshot restores cross-site only when it came from one library and the target has one library. Otherwise it fails under rule 3. Take a fresh backup to restore by name.
:::

## Sharing

Sharing on files and folders is captured and restored as for OneDrive. See [Sharing](./onedrive-backup.md#sharing) and [Restoring sharing](./onedrive-backup.md#restoring-sharing). A permission read that Microsoft Graph refuses lists the item on the library's [failed files](#failed-files) and the run exits `2`, as described in [When permissions cannot be read](./onedrive-backup.md#when-permissions-cannot-be-read).

- Site and library permissions are not part of a backup.
- A restore applies no permission unless you pass `--restore-permissions`.
- The first backup after upgrading lists each library in full once, as described in [First backup after upgrading](./onedrive-backup.md#first-backup-after-upgrading).

::: warning Restoring sharing into another site
With `--target-site` and `--restore-permissions`, the original audience gets access to the copy in the target site. Check who should see it first.
:::

## Folder colours

Folder colours are captured as for OneDrive and are never restored. See [Folder colours](./onedrive-backup.md#folder-colours).

- Microsoft Graph refuses every write to a folder's colour with `403 accessDenied`, so a coloured folder restored into this or another site takes the library's default colour. Writing colours is tracked in [#778](https://github.com/wisecom-oy/atlas/issues/778).
- The restore summary reports `Folder colours not restored` with a count, which does not change the exit code.
- Reading colours adds 1 resource unit per folder the backup receives. See [the cost of capturing folder colours](/security#the-cost-of-capturing-folder-colours).

## Rolling a file back to an earlier version

Version restore brings back an earlier version of one file, or the state of a folder as of a point in time, from the stored version history.

```bash
# List versions of one file
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering \
  -f "/Shared Documents/report.docx"

# Restore one version as a copy beside the original
atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering \
  -f "/Shared Documents/report.docx" --version 3.0

# Roll every file under /Shared Documents/Projects back to 10 March 2026, over the originals
atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering \
  --before 2026-03-10T00:00:00Z --path "/Shared Documents/Projects" --in-place
```

- Content comes from the verified backup, not from the live file.
- By default Atlas writes `report (restored <timestamp>).docx` beside the original and leaves the live file untouched. `--in-place` overwrites the original.
- A file with no version before the cutoff is reported as skipped.
- Versions return to the library they were captured from, so a site with several libraries needs no extra flag.
- Version restore works only within the same tenant and site. To put files into another site, use `restore --target-site`, which restores snapshot state, not history.

## Reading the result

### Snapshot health

Each backup ends with a health status:

| Status      | Meaning                                                                                  | Exit code |
| ----------- | ---------------------------------------------------------------------------------------- | --------- |
| `HEALTHY`   | Every file's current content was backed up in every library. The snapshot is safe to rely on. | `0`  |
| `UNHEALTHY` | At least one file failed, a library failed, an encryption error occurred, or a subsite listing failed under `--include-subsites`. The run is partial. | `2` |
| `UNHEALTHY` | The newest snapshot manifest cannot be read, and nothing else went wrong                 | `9`       |

A hard failure that aborts the run exits `1`. A rejected token on a subsite listing (`401`) is a hard failure and exits `4`. For an unreadable manifest, the run names it; see [damaged manifests](/troubleshooting#damaged-manifests-and-version-indexes). Warnings, such as advisory OneNote notes, print as `[!]` lines and leave the exit code at `0`.

### No snapshot is created

A run creates a snapshot only when something changed. Two outcomes end without one, and they mean different things:

| `summary.noSnapshotReason` | Meaning                                                      | Recovery point                | CLI prints |
| -------------------------- | ------------------------------------------------------------ | ----------------------------- | ---------- |
| `no_changes`               | The site has content, and nothing changed since the last run | An earlier snapshot covers it | `No SharePoint changes detected. Snapshot skipped.` |
| `no_content`               | The site holds nothing to protect                            | None                          | `No SharePoint content found. Nothing was backed up and no snapshot exists.` |

The field is absent when a snapshot was created, and absent when the run was interrupted or ended UNHEALTHY. In those cases check `errors` and `healthy`. A run that stored nothing because it was interrupted, or because every changed file failed, exits `2` and prints:

```text
No snapshot created: the run was interrupted or every change failed.
```

## When a file cannot be backed up

One file that cannot be read never stops the rest of the library. Atlas keeps the files that succeeded, moves the sync checkpoint forward, and records the failure.

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
- If it was listed because its permissions could not be read, they are read again without downloading the file, and the failure clears once they are. See [When permissions cannot be read](./onedrive-backup.md#when-permissions-cannot-be-read).
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
| Storage failure while writing the file, at any size: a full disk or quota, an S3 `5xx` once the retries are spent, or an endpoint that never answers | No. The library fails instead and the file is not listed, see below |

A file that has failed only for reasons outside it is reported as `will retry (no attempt counted yet)`, and the run stays UNHEALTHY with exit code `2`, so an outage stays visible. Such a file is retried on every run until it backs up. When a Microsoft Graph call spends its whole retry budget, the run also stops there and exits `3`, keeping the file listed with its attempts unchanged. See [When retries run out](/operations/reliability#when-retries-run-out-on-a-throttle).

A storage failure is the backend's, not the file's. It fails the library like a missing permission does: the library keeps its sync checkpoint, so the next run reads the file again from the change listing, and the failure is reported as the library's error with exit code `2`. When storage stays full or down, the run's own commit fails as well and the command exits with that storage error's code, as listed in [Exit codes](/reference/cli#exit-codes).

After 5 attempts the file is no longer retried, but every run reports it as `PERMANENTLY SKIPPED after 5 attempts`. The run stays UNHEALTHY until the file is fixed or removed in the source. To fetch it again once the cause is fixed, run a full backup:

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --full
```

A full backup ignores the saved sync checkpoint and its list of failed files, so every file is read again and a listed file starts with a fresh budget. It downloads all content again, but content already in storage is not uploaded twice. Editing the file in Microsoft 365 also gets it read once more, because the change listing presents changed files again.

#### A listed file that answers not found

A file on the failed list stays listed when Microsoft Graph answers its re-read with `404` or `itemNotFound`. It keeps its attempts, the run stays UNHEALTHY with exit code `2`, and it is reported with the reason `Graph answered "not found" when re-reading the file`. The next run reads it again, and once Graph answers normally it is stored.

A single `404` is not proof of deletion. Graph returns it during service incidents and from replica lag, and Atlas does not retry a `404`. The library's sync checkpoint has already moved past the file, and the change listing (delta) never re-presents an unchanged file, so dropping it on one `404` would leave it out of every later snapshot while the run reported HEALTHY.

The failure is dropped as a deletion in either of these cases:

| Evidence | When the failure is dropped |
| -------- | --------------------------- |
| The change listing reports the file as deleted | In that run. This is how a real deletion normally clears. |
| The re-read answers `404` on 3 runs in a row, spanning at least 24 hours | On the run that meets both conditions |

Both conditions are needed for the second case. A run count alone would let a one-hour incident clear a file on a 15-minute schedule, and a time span alone would decide on two answers a day apart. Any other outcome for the file, such as a failed download, starts the count again. The second case covers a deletion that the change listing never reported, such as one hidden by a full re-read of the library after a delta reset, so a deleted file does not stay listed indefinitely.

### Expired download links

Microsoft 365 gives Atlas a time-limited download link for each file. On a long run a link can expire before Atlas reaches the file or while it is reading it. Atlas fetches a fresh link and continues, resuming large files where they stopped. If the file still cannot be read, it is recorded as not backed up and retried on the next run without using an attempt, at any file size. A body of the wrong length or a `404` from the fallback after the fresh link still uses one, because it says something about the file.

::: details How expired links are handled, by file size
A `401` or `403` from the download link means it expired.

| File size                | Link at download start          | When the link expires mid-transfer                                                       |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Up to 4 MiB              | Link from the change listing    | Fetch a fresh link once, retry the whole file, then fall back to the Graph `/content` endpoint. A download host that is down on the fresh link is retried instead, see below |
| Over 4 MiB, under 64 MiB | Link from the change listing    | Fetch a fresh link once, restart from byte zero, then fall back to `/content`            |
| 64 MiB and larger        | Fresh link, one Graph request   | Fetch a fresh link and resume at the 4 MiB range that failed                             |

For files of 64 MiB and larger, a run can refresh the link any number of times, as long as each fresh link delivers at least one more range. If three fresh links in a row expire before any new range arrives, Atlas records the file as not backed up, without counting an attempt. A Graph refusal while fetching a fresh link is handled like the other `403` cases: a missing grant stops the run, a protection code is recorded as permanent, and any other `403` fails the file for that run. The fresh link costs one Graph request per file of 64 MiB or more.
:::

### Version failures

| Situation | Result |
| --- | --- |
| Unexpected failure: throttling, `403 accessDenied`, transient fault | Error. The run is UNHEALTHY. |
| `404` or `410`, and the version is no longer in the file's version list (purged by the site's retention policy) | Counted as `unavailable`. Health is unaffected. |
| `404` or `410`, and the version is still listed | Error. The run is UNHEALTHY. Counted as `unavailable` once the answer repeats on 3 runs in a row spanning at least 24 hours |
| Download delivers fewer or more bytes than listed | Fails with `DownloadIntegrityError` before anything is stored. The run is UNHEALTHY. |
| Version larger than 312.5 GiB | Counted as `unavailable` without being downloaded, and never retried. Health is unaffected. |

Only the HTTP status of the response decides between error and `unavailable`. An error whose message text happens to contain "404" or "Not Found" is an ordinary failure. A `404` is not proof the version is gone: Microsoft Graph returns one during incidents, and the run listed the version moments earlier. Atlas therefore reads the version list once more for that file before counting a version as purged, which costs one extra request per file and only when a `404` or `410` occurs.

A failed version stops the file's [watermark](/operations/delta-sync#file-version-capture-onedrive-and-sharepoint), so it is downloaded again, along with every newer version, by the next backup that picks up the file. Newer versions already stored deduplicate.

The same holds when a run stores a file's content and then stops before capturing its versions: the library or the file fails, the version listing fails, or Ctrl+C ends the run. The cursor records the file as owing versions, and the next run that sees it captures them even though the content is already stored. A file whose versions were all captured costs no version request when its content deduplicates, for example on a `--full` run.

### Files that change size

Every download is checked against the size the change listing reported. A file can change between its listing and its download, and SharePoint can rewrite a file on its first download without creating a version. When the size differs, Atlas reads the file's details once more and downloads it again at its current size, and the snapshot records that size.

A file whose size still changes fails with `DownloadIntegrityError`, is recorded as a failed file, and leaves the run UNHEALTHY. After 5 failed attempts it is reported as `PERMANENTLY SKIPPED`.

::: details Size check details
Each range of a chunked download also carries the file's total length in its `Content-Range` header, which is checked too. The refresh costs one item read per mismatching file, and a file gets at most one refresh per run. A truncated transfer or a wrong byte range is never refreshed and fails at once.
:::

## Stopping a run

**Backup.** Ctrl+C stops a backup at once, including in the middle of a download, during a Microsoft Graph call, and during a retry or throttle wait. A file interrupted this way is not recorded as failed, so it keeps its 5 attempts for the next run. Rerunning the backup is safe. With `--include-subsites`, Ctrl+C between two sites exits `2`, and the next site is reported as not backed up.

**Restore.** The first Ctrl+C stops the restore at once, but lets a write already sent to Microsoft 365 finish, because Microsoft 365 may already have committed it. The command prints the files restored so far and exits `2`. A file stopped before it was written is not reported as failed. `restore-version` behaves the same way.

::: warning Second Ctrl+C during a restore
A second Ctrl+C exits at once with status `130` and skips the safe stop. A file whose upload was in flight may or may not exist. Check the destination before retrying, especially with `--in-place`.
:::

::: details Which writes finish after Ctrl+C
A file up to 4 MiB is uploaded in one request. A larger file is created by the final chunk of its upload session, so that request finishes, up to its deadline of about 82 s, and the file counts as restored if Microsoft 365 accepted it. A final chunk that did not complete cleanly is named in the errors as `outcome unknown, the file may exist`. A larger file stopped before its final chunk is not created, and its upload session is deleted. See [Upload sessions](/operations/reliability#upload-sessions).
:::

See [reliability](/operations/reliability) for retries and what is safe to rerun.

## Limits

| Area                 | Limit                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Downloads            | Up to 4 MiB in one request; 4 to 64 MiB in 4 MiB ranges; 64 MiB and larger streamed through a staging upload |
| File size            | 312.5 GiB per file or version, above Microsoft 365's 250 GB. See [object size limits](/self-hosting/storage#object-size-limits) |
| Uploads on restore   | Up to 4 MiB in one request; larger files in a resumable upload session in 10 MiB chunks           |
| Throttling           | Retried with backoff, see below                                                                    |
| Path length          | A restore folder adds path depth. Files over SharePoint's path length limit are skipped and reported. |
| Scope                | File authors and folder colours are not restored. Item sharing is restored only with `--restore-permissions`. Site and library permissions are not captured |

When Microsoft 365 throttles requests or has a transient fault, Atlas waits and retries. See [Graph rate limits](/operations/graph-rate-limits) for request budgets.

::: details Retry and throttling details
- Graph `429`, transient `500`, `502`, `503` and `504` responses, and dropped connections are retried with backoff, up to 5 times per range for chunked downloads.
- A file up to 4 MiB is read from its download link in one request. A `429` there is retried up to 3 times against the same link.
- A file under 64 MiB whose download host answers `429` or `5xx`, resets, or times out gets 3 attempts with backoff from 2 s, then is listed for the next run without using an attempt. It is not sent to the Graph `/content` endpoint, which redirects to the same host. [File transfers](/operations/reliability#file-transfers-onedrive-and-sharepoint) lists the longest wait per file during a host outage.
- A timed-out `/content` request is aborted before the next attempt, and counts toward the same 3 attempts.
- A `Retry-After` on a download is honoured in either form, seconds or an HTTP date, and capped at one hour.
:::

## Storage layout

Site data lives in the per-tenant bucket, under the `sharepoint/` prefix:

```
atlas-{tenant_id}/
  sharepoint/
    data/{site_id}/{content_name}        # Encrypted file blobs (keyed content names)
    manifests/{site_id}/{snapshot_id}.json
    index/{site_id}/files/{file_id}.json
    staging/{site_id}/{item_id}-{rand}   # In-flight large-file uploads
    _meta/{site_id}/delta.json           # Encrypted sync checkpoint per library
```

Object paths use the site ID without its hostname, for example `<site-guid>,<web-guid>`. Files of 64 MiB and larger pass through `staging/` before they are copied to their final path. See [storage layout](/operations/storage-layout) for the whole bucket.

::: warning Upgrading from v5
v5 stored data under the full site ID, including the hostname. There is no migration, and old objects stay in the bucket until deleted. See [Migrating to v6](/migration/v6).
:::

## SDK usage

The SDK exposes the same operations on `atlas.sharepoint`. Options and results use camelCase. Site arguments accept a URL or a `host,site-guid,web-guid` ID.

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

const site = 'https://contoso.sharepoint.com/sites/Engineering';

// backup() returns one result per site, root first
const [root] = await atlas.sharepoint.backup(site);
console.log(`Snapshot: ${root.snapshot?.snapshotId}, stored: ${root.summary.filesStored}`);

// Include subsites: one snapshot and one result per site
const tree = await atlas.sharepoint.backup(site, { includeSubsites: true });
console.log(`Backed up ${tree.length} site(s)`);

// Verify a snapshot
const verify = await atlas.sharepoint.verify(site, 'sp-snap-1735689600000-a1b2c3');
if (verify.failedFileIds.length > 0) {
  console.error('Failed files:', verify.failedFileIds);
}

// Restore into a Restore-<timestamp> folder in each library
const restored = await atlas.sharepoint.restore(site, {
  snapshotId: 'sp-snap-123',
  conflictBehavior: 'rename',
});
console.log(`Restored: ${restored.filesRestored} files`);

// Save to a local zip archive
const saved = await atlas.sharepoint.save(site, {
  snapshotId: 'sp-snap-123',
  outputPath: 'sharepoint-backup.zip',
});
console.log(`Saved: ${saved.filesSaved} files`);

// Erase all data for a site
const deletion = await atlas.sharepoint.deleteSiteData(site);
console.log(`Deleted: ${deletion.deletedObjects} objects`);
```

Other methods: `restoreVersion`, `listSnapshots`, `listFileVersions`, `listPermissions`, `checkStatus`, and `deleteSnapshot`. See the [SDK reference](./reference/sdk.md).

### Site discovery

List the tenant's sites, skip SharePoint Embedded containers, and handle sites Microsoft 365 refuses:

```ts
import { GraphAccessRefusedError, isFileStorageContainerSite } from '@wisecom/atlas-sdk';

const sites = await atlas.sharepoint.listSites();
for (const s of sites) {
  if (s.kind === 'file_storage_container') continue; // SharePoint Embedded, not backed up
  try {
    await atlas.sharepoint.backup(s.siteId);
  } catch (err) {
    if (!(err instanceof GraphAccessRefusedError)) throw err;
    // Retrying returns the same answer. Containers were skipped above, so check this site's
    // per-site grant before treating it as unsupported.
    console.log(
      `Refused: ${err.site_id} (${err.reason}, HTTP ${err.status_code} ${err.graph_code})`,
    );
  }
}

// The same rule for sites found by your own discovery
isFileStorageContainerSite('https://contoso.sharepoint.com/contentstorage/CSP_example'); // true

const resolved = await atlas.sharepoint.resolveSite(site);
console.log(resolved.siteId, resolved.kind);
```

## See also

- [CLI reference](./reference/cli.md)
- [Programmatic SDK](./reference/sdk.md)
- [OneDrive backup](./onedrive-backup.md)
- [Security](/security)
