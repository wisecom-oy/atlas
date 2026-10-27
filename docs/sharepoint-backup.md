---
description: Back up SharePoint document libraries incrementally with Microsoft Graph delta queries, encrypting files before storage and recording a snapshot per run.
---

# SharePoint backup

Atlas backs up the document libraries of a SharePoint site incrementally with Microsoft Graph delta queries. Files are encrypted before storage and stored once per unique content. One run covers every document library in the site, and each run that changes something records a snapshot.

For per-user drives, see [OneDrive backup](./onedrive-backup.md).

## Quick start

```bash
# Back up a site by URL
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering

# Force a full crawl, ignoring saved delta state
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --full

# Verify a snapshot
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering \
  -s sp-snap-1735689600000-a1b2c3
```

`--site` accepts a site URL or a Graph site ID. The ID can include the hostname (`contoso.sharepoint.com,<site-guid>,<web-guid>`) or omit it (`<site-guid>,<web-guid>`). Snapshot IDs have the form `sp-snap-<milliseconds>-<6-hex>`, and `backup` prints the ID of each snapshot it creates.

## What is backed up

| Item | Coverage |
| --- | --- |
| Files in every document library | Current content, deduplicated by content within the site |
| Version history | Earlier versions Graph returns for each file |
| Library and folder paths | Recorded in the snapshot manifest |
| OneNote notebooks | Section files and table of contents, stored as ordinary files ([details](#onenote-notebooks)) |
| Subsites | Only with `--include-subsites`, one snapshot per subsite |
| Moves, renames, deletions | Recorded as changes on the next run |

## Permissions

Add these application permissions to the Atlas app registration in Microsoft Entra ID, and grant admin consent:

| Permission | Used for |
| --- | --- |
| `Sites.Read.All` | Listing sites and reading library metadata |
| `Files.Read.All` | Reading file content for backup, verify, and save |
| `Sites.ReadWrite.All` | Restore only |

If a permission is missing, the run stops before touching files and names the missing scope, for example `Missing Microsoft Graph application permissions for SharePoint: Sites.Read.All.`

## Commands

Most commands take `--site <url-or-id>`. Snapshot is `-s`, because `-s` is not used for the site.

### list-sites

```bash
atlas sharepoint list-sites
```

Lists the sites in the tenant that Atlas can back up. Takes only `-t, --tenant <id>`.

### backup

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | Site URL or Graph site ID | Required |
| `--full` | Ignore saved delta state and crawl every library | `false` |
| `--include-subsites` | Also back up every subsite beneath the site, one snapshot each | `false` |
| `--retention-days <n>` | Apply Object Lock retention to stored objects | Off |
| `--lock-mode <mode>` | `governance` or `compliance`; requires `--retention-days` | Not set |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --include-subsites
```

Each library keeps its own delta cursor.

### restore

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | Source site | Required |
| `-s, --snapshot <id>` | Snapshot to restore | Required |
| `--target-site <url-or-id>` | Restore into a different site | Source site |
| `--destination <path>` | Folder to restore under; created when missing | `/Restore-<timestamp>` |
| `--in-place` | Restore to the original paths | `false` |
| `--name <filename>` | Rename the restored file; single-file restores only | Original name |
| `--file-filter <paths...>` | Restore only the given files, by ID or path | All files |
| `-c, --conflict <mode>` | `rename`, `replace`, or `fail` | `rename` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
# Restore everything into a fresh Restore-<timestamp> folder in each library
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123

# Restore into a different site
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --target-site https://contoso.sharepoint.com/sites/Staging

# Restore two files, replacing any that exist
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --file-filter /Documents/report.docx /Documents/budget.xlsx -c replace
```

Restored files keep their original created and modified timestamps. Each file is decrypted and checked against its SHA-256 checksum before upload. A file whose stored bytes do not match the manifest is reported as a restore error, is not created, and makes the run exit non-zero.

### restore-version

Brings back earlier versions of a file, or of every file as of a point in time. See [rolling a file back to an earlier version](./onedrive-backup.md#rolling-a-file-back-to-an-earlier-version) for the behavior, which is the same for both workloads.

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | Site | Required |
| `-f, --file <ref>` | File ID or path; required with `--version` | Optional |
| `--version <id>` | Exact stored version to restore | Optional |
| `--before <iso>` | Newest version at or before this instant, per file | Optional |
| `--path <prefix>` | Limit a `--before` rollback to one folder | Whole site |
| `--in-place` | Upload over the original file | `false`, writes a copy |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering \
  -f "/Shared Documents/report.docx"

atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering \
  -f "/Shared Documents/report.docx" --version 3.0

atlas sharepoint restore-version --site https://contoso.sharepoint.com/sites/Engineering \
  --before 2026-03-10T00:00:00Z --path "/Shared Documents/Projects" --in-place
```

Versions return to the library they were captured from, so a site with several libraries needs no extra flag. Version restore has no cross-site form. Use `restore --target-site` for that, which restores snapshot state rather than history.

### save

Writes a zip archive instead of uploading to Graph. The archive keeps the library folder hierarchy, and files larger than 4 MiB are decrypted as a stream.

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | Site | Required |
| `-s, --snapshot <id>` | Snapshot to save from | Required |
| `--file-filter <paths...>` | Save only the given files, by ID or path | All files |
| `--output <path>` | Output zip file path | Auto-generated |
| `--skip-verify` | Skip SHA-256 checks while saving | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --output ~/Downloads/backup.zip
```

::: warning Mark-of-the-Web on Windows
On Windows the archive is stamped with Mark-of-the-Web (`Zone.Identifier`, `ZoneId=3`), so extracted Office files open in Protected View and macros stay blocked. Clear the mark once you trust the content:

```powershell
Get-ChildItem -Recurse <dir> | Unblock-File
```

Nothing is written on macOS or Linux. See the [CLI reference](./reference/cli.md) for archive details.
:::

### verify

Checks a snapshot without restoring anything. For each entry, Atlas confirms the per-file index has a record for the snapshot, decrypts the stored blob, recomputes SHA-256 over the plaintext, and compares the digest with the manifest using a constant-time comparison. Content is streamed, so verification memory does not grow with file size.

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | Site | Required |
| `-s, --snapshot <id>` | Snapshot to verify | Required |
| `-t, --tenant <id>` | Tenant identifier | Config default |

```bash
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
```

Exit code `0` means every checked entry passed. Exit code `1` means a blob mismatch or index inconsistency was found.

### list-snapshots and list-versions

```bash
atlas sharepoint list-snapshots --site https://contoso.sharepoint.com/sites/Engineering
atlas sharepoint list-versions --site https://contoso.sharepoint.com/sites/Engineering \
  -f "/Shared Documents/report.docx"
```

### status

```bash
atlas sharepoint status --site https://contoso.sharepoint.com/sites/Engineering
```

Reports whether each library is up to date, using a Graph delta peek. The peek reads saved delta state without advancing it.

### delete

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | Site | Required |
| `-s, --snapshot <id>` | Delete one snapshot instead of all data for the site | All data |
| `-y, --yes` | Skip the confirmation prompt | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

Deletion erases every version of each object. Objects still protected by Object Lock are reported as retained, separately from failures. See [erasure](/security#erasure). To remove all data for a tenant across every workload, use `atlas delete --purge`.

## Storage layout

Site data lives in the per-tenant bucket, under the `sharepoint/` prefix:

```
atlas-{tenant_id}/
  sharepoint/
    data/{site_id}/{content_name}        # Encrypted file blobs (keyed content names)
    manifests/{site_id}/{snapshot_id}.json
    index/{site_id}/files/{file_id}.json
    staging/{site_id}/{item_id}-{rand}   # In-flight large-file uploads
    _meta/{site_id}/delta.json           # Encrypted delta state per library
```

Keys use the site ID without its hostname, for example `<site-guid>,<web-guid>`.

::: warning Upgrading from v5
v5 keyed storage by the full ID, including the hostname. There is no migration, and old objects stay in the bucket until deleted. See [Migrating to v6](/migration/v6).
:::

## Where restored files land

A restore creates `Restore-<timestamp>` in each destination library and recreates the original folder structure beneath it. A file backed up from `/Reports/2026` returns to `/Restore-2026-08-27T10-15-30/Reports/2026`. Deleting that folder undoes the restore.

The default is a restore root because the `rename` conflict mode alone leaves suffixed copies scattered through live library content. Use `--in-place` to restore to the original paths, and `--destination` to choose the folder name.

`--name` is rejected when more than one file matches, so pair it with `--file-filter`. A file that exceeds the path length limit after nesting is reported as a skipped item and does not abort the run.

With `--in-place`, each manifest entry's stored `drive_id` decides the library, so files return to the library they came from.

## Where a cross-site restore lands

A manifest entry records the `drive_id` of its source library. That ID belongs to the source site, so a cross-site restore has to choose a library in the target site for each entry:

1. **Same library name.** The target library with the same name, compared case-insensitively after Unicode NFC normalization and trimming whitespace. If two target libraries share the name, the restore fails rather than picking one.
2. **The only library.** Used only when the snapshot came from a single library and the target site has one library. Snapshots from several libraries are never folded into a single destination library.
3. **Neither.** The file is refused, the candidate libraries are named, and the run exits non-zero. Atlas never guesses a production library.

If the target site has no document libraries, the restore fails before uploading anything.

::: warning Snapshots taken before 2.1.0-beta
Older manifests do not record library names, so rule 1 cannot apply. Such a snapshot restores cross-site only when it came from one library and the target has one library. Otherwise it fails under rule 3. Take a fresh backup to restore by name.
:::

## Failed items and health

A file that cannot be downloaded does not stop the library. Atlas keeps the files that succeeded, advances the delta state, and records the failure. Each recorded failure is retried at the start of the next run, before new changes are processed. After 5 attempts it is reported on every run as `PERMANENTLY SKIPPED after 5 attempts`, and the run stays UNHEALTHY until the file is fixed or removed in the source.

Other content the service refuses to serve is handled as follows:

- **Malware quarantine** is detected from delta metadata before any download. It is reported as permanently skipped by service policy and does not use the 5-attempt budget.
- **403 responses** are classified by HTTP status and Graph error code. A missing application permission stops the run. A protection or policy state (sensitivity label, IRM, retention) is recorded against that one file, with the Graph error code. An expired pre-authenticated download URL is re-resolved and retried once. Any other unrecognized 403 costs one file, not the run.

### Health status

Each backup ends with a health status:

- **HEALTHY.** Every file's primary content was backed up in every library.
- **UNHEALTHY.** At least one file failed, a library crashed, or an encryption error occurred. The run exits with code `2` for a partial run. A hard failure that aborts the run exits with code `1`.

A version that fails to download for an unexpected reason (throttling, `403 accessDenied`, a transient fault) makes the run UNHEALTHY. A version Graph reports as gone (`404` or `410`, purged by the site's retention policy) is counted as `unavailable` and does not affect health.

## No snapshot is created

A run creates a snapshot only when something changed. Two outcomes end without one, and they mean opposite things:

| `summary.noSnapshotReason` | Meaning | Recovery point |
| --- | --- | --- |
| `no_changes` | The site has content, and nothing changed since the last run | An earlier snapshot covers it |
| `no_content` | The site holds nothing to protect | None |

The field is absent when a snapshot was created, and absent when the run was interrupted or ended UNHEALTHY. In those cases, check `errors` and `healthy`. The CLI prints `No SharePoint changes detected. Snapshot skipped.` for `no_changes`, and warns that nothing was backed up for `no_content`.

## OneNote notebooks

A OneNote notebook is stored as its section files (`.one`) and its table of contents (`.onetoc2`), each backed up byte-for-byte as an ordinary file. The run reports how many notebooks it found, and warns when a notebook is captured incompletely. A table of contents stored without its sections restores into a notebook that will not open.

Restored sections arrive as ordinary files. Treat notebook restore as recovering the section data, let OneNote re-import it, and verify the result before relying on it.

## Limits

- **Downloads.** Files up to 4 MiB are read in one request. Files from 4 to 64 MiB are read in 4 MiB ranges. Files of 64 MiB and larger are streamed into multipart uploads on staging, then copied to their content key.
- **Uploads on restore.** Files up to 4 MiB use a single PUT. Larger files use a resumable session in 10 MiB chunks.
- **Throttling and CDN faults.** Graph `429` and transient `5xx` responses are retried with backoff, per range for chunked downloads.
- **Scope.** Sharing permissions are not captured, and restores do not recreate file authors. See [what a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

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

### Site discovery

```ts
const sites = await atlas.sharepoint.listSites();
for (const s of sites) {
  console.log(`${s.displayName}: ${s.siteUrl} (${s.siteId})`);
}

const resolved = await atlas.sharepoint.resolveSite(site);
console.log(resolved.siteId);
```

Other methods: `restoreVersion`, `listSnapshots`, `listFileVersions`, `checkStatus`, `deleteSnapshot`, and the replication methods below.

## Replication

Replication copies encrypted snapshot data to a second S3-compatible target without decrypting it. The replica includes blobs, manifests, version indexes, and delta state, so incremental backups resume after a rehydrate.

```bash
# Replicate one snapshot, or every snapshot that has not been replicated
atlas replicate --site contoso.sharepoint.com,<site-guid>,<web-guid> -s sp-snap-123 \
  --target-config ./offsite.json
atlas replicate --site contoso.sharepoint.com,<site-guid>,<web-guid> --target-config ./offsite.json

# Recover the whole site, or one snapshot
atlas rehydrate --site contoso.sharepoint.com,<site-guid>,<web-guid> --source-config ./offsite.json
atlas rehydrate --site contoso.sharepoint.com,<site-guid>,<web-guid> -s sp-snap-123 \
  --source-config ./offsite.json
```

```ts
const offsite = createStorageTarget({ /* ... */ });

await atlas.sharepoint.replicateAll(site, [offsite]);
await atlas.sharepoint.rehydrateSite(site, offsite);
```

See [replication](./operations/replication.md) for target setup and disaster recovery.

## See also

- [CLI reference](./reference/cli.md)
- [Programmatic SDK](./reference/sdk.md)
- [OneDrive backup](./onedrive-backup.md)
- [Security](/security)
