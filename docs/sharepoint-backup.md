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

Sharing permissions are not captured, and restores do not recreate file authors. See [what a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

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
| `Sites.ReadWrite.All` | Restore only                                      |

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

Each run picks up from a sync checkpoint (a Microsoft Graph delta link) saved by the previous one. Each library keeps its own checkpoint. See [incremental sync](/operations/delta-sync).

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
| `-t, --tenant <id>`         | Tenant identifier                                   | Config default         |

```bash
# Restore everything into a fresh Restore-<timestamp> folder in each library
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123

# Restore into a different site
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --target-site https://contoso.sharepoint.com/sites/Staging

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

### list-snapshots and list-versions

```bash
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering \
  -f "/Shared Documents/report.docx"
```

`list-versions` takes `-f, --file <ref>` (a file ID or path, required).

### status

```bash
atlas sharepoint status --site https://contoso.sharepoint.com/sites/Engineering
```

Reports, per library, the file changes waiting for the next backup and the files in the list of failed files. It reads the sync checkpoint without moving it, so the next backup is unaffected. A library is up to date only when it has no pending file and no failed file, so a site with files still waiting for a retry is not reported as current. A Microsoft Graph `401` or `403` exits with code `4`. See the [status columns](/reference/cli#drive-status-columns).

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
| Microsoft 365 reports the version gone (`404` or `410`, purged by the site's retention policy) | Counted as `unavailable`. Health is unaffected. |
| Download delivers fewer or more bytes than listed                | Fails with `DownloadIntegrityError` before anything is stored. The run is UNHEALTHY. |

Only the HTTP status of the response decides between error and `unavailable`. An error whose message text happens to contain "404" or "Not Found" is an ordinary failure. A failed version is downloaded again by the next backup that picks up a change to the file.

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
A file up to 4 MiB is uploaded in one request. A larger file is created by the final chunk of its upload session, so that request finishes and the file counts as restored if Microsoft 365 accepted it. A larger file stopped before its final chunk is not created, and its upload session is deleted.
:::

See [reliability](/operations/reliability) for retries and what is safe to rerun.

## Limits

| Area                 | Limit                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Downloads            | Up to 4 MiB in one request; 4 to 64 MiB in 4 MiB ranges; 64 MiB and larger streamed through a staging upload |
| Uploads on restore   | Up to 4 MiB in one request; larger files in a resumable upload session in 10 MiB chunks           |
| Throttling           | Retried with backoff, see below                                                                    |
| Path length          | A restore folder adds path depth. Files over SharePoint's path length limit are skipped and reported. |
| Scope                | Sharing permissions and file authors are not restored                                              |

When Microsoft 365 throttles requests or has a transient fault, Atlas waits and retries. See [Graph rate limits](/operations/graph-rate-limits) for request budgets.

::: details Retry and throttling details
- Graph `429`, transient `500`, `502`, `503` and `504` responses, and dropped connections are retried with backoff, up to 5 times per range for chunked downloads.
- A file up to 4 MiB is read from its download link in one request. A `429` there is retried up to 3 times against the same link before Atlas falls back to the Graph `/content` endpoint.
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

Other methods: `restoreVersion`, `listSnapshots`, `listFileVersions`, `checkStatus`, and `deleteSnapshot`. See the [SDK reference](./reference/sdk.md).

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
