# SharePoint Backup

Atlas backs up SharePoint document library files incrementally using Microsoft Graph delta queries. Changed files are encrypted with AES-256-GCM and stored content-addressed in S3-compatible object storage. File version history is preserved across syncs.

Backup is site-targeted: one run processes every document library in a single SharePoint site. For per-user drives, see [OneDrive Backup](./onedrive-backup.md).

## What Gets Backed Up

| Item                          | Coverage                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Files in every document library | Current content, SHA-256 content-addressed and deduplicated per site                                      |
| File version history          | Every new historical version Graph returns for an item                                                      |
| Library and folder paths      | Recorded on the manifest entry, one delta cursor per library                                                |
| OneNote notebooks             | Section files and table of contents, stored as ordinary files (see [OneNote Notebooks](#onenote-notebooks)) |
| Subsites                      | Only with `--include-subsites`, which produces one snapshot per subsite                                     |
| Moves, renames, and deletions | Recorded as manifest changes on the next delta sync                                                         |

## Prerequisites

Add these application permissions to your app registration, in addition to any existing Outlook or OneDrive backup permissions:

| Permission       | Type        | Purpose                                                    |
| ---------------- | ----------- | ---------------------------------------------------------- |
| `Sites.Read.All` | Application | List sites and read document library metadata              |
| `Files.Read.All` | Application | Read file content from document libraries (backup, verify) |

Backup needs read permissions only. Restore additionally requires `Sites.ReadWrite.All` to upload files back to the site.

## Quick Start

```bash
# Back up a SharePoint site by URL
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering

# Force full sync (ignores saved delta state)
atlas sharepoint backup --site https://contoso.sharepoint.com/sites/Engineering --full

# Back up using a Graph site ID directly
atlas sharepoint backup --site contoso.sharepoint.com,guid,guid

# Verify snapshot integrity
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
```

Snapshot IDs are generated as `sp-snap-<milliseconds>-<6-hex>` (for example `sp-snap-1735689600000-a1b2c3`). Use the value printed at the end of a successful backup.

## How It Works

1. **Site resolution.** The `--site` flag accepts either a SharePoint site URL (`https://contoso.sharepoint.com/sites/Engineering`) or a Graph site ID (`contoso.sharepoint.com,site-guid,web-guid`). URLs are resolved via `GET /sites/{hostname}:/{path}` to obtain the canonical site ID used for all storage keys.
2. **Library discovery.** Atlas calls `GET /sites/{site_id}/drives?$filter=driveType eq 'documentLibrary'` to discover all document libraries within the site. Each library has its own delta cursor, allowing independent incremental tracking.
3. **Delta sync.** For each document library, Atlas follows `GET /drives/{drive_id}/root/delta`, or the stored OData `deltaLink`, to discover changed files since the last backup. Invalid or expired delta tokens trigger a full delta reset on the next attempt. A file that fails to download does not discard the rest of the library: successful entries are kept, the delta link advances, and the failure is recorded for retry (see [Failed Items and Delta Progress](#failed-items-and-delta-progress)). A library that fails outright, before any delta could be read, leaves its link untouched so the next run retries it cleanly. The delta cursor is saved incrementally after each successfully completed library.
4. **Content-addressed storage.** Each file is SHA-256 hashed over the plaintext before encryption. If the same content already exists for that site, the blob is deduplicated (no second upload).
5. **Zero-disk streaming.** Files at or above **64 MiB** use a streaming pipeline: 4 MiB download segments are encrypted and assembled into **8 MiB** S3 multipart parts, staged under `sharepoint/staging/`, then copied to the canonical `sharepoint/data/` key or aborted if the content hash already exists. Peak working set is dominated by one download buffer plus one upload part, on the order of **12 MiB** per large file rather than the full file size.
6. **Version history.** After the current version is processed, Atlas calls `GET /drives/{drive_id}/items/{item_id}/versions` and stores any new historical versions the same way as live content, including the streaming threshold: a historical version at or above **64 MiB** streams rather than buffering. A version carries no size limit of its own, so a large file's history is otherwise the easiest way to exhaust the heap.
7. **Encrypted manifests and sidecars.** Each backup run that records changes builds a snapshot manifest (entries, checksums, paths). Manifests, per-file version indexes, and delta cursor JSON are encrypted with the tenant DEK on `put`, consistent with the rest of Atlas.

### Storage Layout

Paths live in the **same per-tenant bucket** as mailbox and OneDrive backup (see [Storage Layout](./operations/storage-layout.md)), under the `sharepoint/` prefix:

```
atlas-{tenant_id}/
  sharepoint/
    data/{site_id}/{sha256}              # Encrypted file blobs (content-addressed)
    manifests/{site_id}/{snapshot_id}.json
    index/{site_id}/files/{file_id}.json
    staging/{site_id}/{item_id}-{rand}   # Temporary multipart / dedup staging
    _meta/{site_id}/delta.json           # Encrypted delta link + per-library cursor state
```

Object keys use the **Graph site ID** (for example `contoso.sharepoint.com,aaa-bbb,ccc-ddd`). The CLI resolves site URLs to site IDs automatically.

Ciphertext is stored at the key name shown above. There is no separate `.enc` filename suffix, because encryption is applied by the storage layer.

### File Size Handling

Implementation thresholds from `@wisecom/atlas-sharepoint`:

| Size                          | Strategy                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **≤ 4 MiB**                   | Single read via pre-authenticated URL (with transient-status retry and Retry-After backoff) or Graph content fallback, encrypt, `put`                                                          |
| **> 4 MiB** and **< 64 MiB**  | Range-based chunked download (`CHUNK_SIZE_BYTES` = 4 MiB), encrypt, `put`                                                                                                                      |
| **≥ 64 MiB**                  | Streaming pipeline: chunk download into streaming encrypt into multipart upload on staging, complete or abort after dedup check, then server-side copy to `sharepoint/data/{site_id}/{sha256}` |

Chunked downloads retry each **4 MiB** range independently (5 attempts with exponential backoff), so a transient failure replays a single chunk instead of the whole file. A chunk is retried on the same statuses as any other Graph call (429, 500, 502, 503, and 504), because the CDN in front of Graph raises `500` and `502` under load. A `4xx` response fails the chunk immediately.

### Download Resilience

SharePoint's direct download URLs (pre-authenticated CDN links via `@microsoft.graph.downloadUrl`) are subject to Microsoft Graph rate limiting, and the CDN also returns transient gateway faults of its own. Atlas handles this with:

- **Transient-status detection** on direct download URLs. `429`, `500`, `502`, `503`, and `504` are retried, with `Retry-After` header parsing that supports both delta-seconds and HTTP-date formats.
- **Exponential backoff** when `Retry-After` is absent or carries no usable wait (base 1s, max 32s, with jitter). A `Retry-After` in the past is treated as absent, since honouring it as "retry now" would remove the jitter that stops concurrent workers retrying in lockstep. A value further out than an hour is capped at an hour and treated as a server bug rather than an instruction.
- **Graph content fallback.** If the pre-authenticated URL fails after retries, Atlas falls back to `GET /drives/{drive_id}/items/{item_id}/content`, which routes through the Graph gateway rather than the CDN.
- **Stall timeout per chunk.** Each range request is aborted if the chunk has not transferred at roughly 256 KB/s, with a floor of 30 seconds. The budget is sized from the chunk being fetched, not the file, so a dead connection costs about 30 seconds and then a retry regardless of whether the file is 5 MB or 5 GB. If the CDN ignores the `Range` header and answers `200` with the whole file, the budget is re-sized to that body before it is read.

## Failed Items and Delta Progress

A file that refuses to download, whether from a permissions quirk, a corrupted item, IRM-protected content, or a chronically 4xx-ing CDN link, must not be able to stop the rest of the library from being backed up. Atlas therefore **advances past per-item failures and records them**, rather than discarding the batch:

1. Items that succeeded are kept and land in the snapshot.
2. The delta link advances, so the next run picks up new changes instead of replaying the whole backlog.
3. Each failure is written into the library's delta cursor as a `failed_items` record: item id, name, reason, attempt count, and when it first failed.
4. The run is reported **UNHEALTHY** (non-zero exit) for as long as any failure is outstanding.
5. Healthy libraries in the same site are unaffected.

Earlier releases discarded a library's entire batch on a single failure and held its cursor back. That traded one bad file for a library that silently stopped receiving backups, and left uploaded-but-unreferenced blobs behind.

The record is what makes advancing safe. Graph delta only re-presents items that _changed_, so a failure that was merely logged would be a file that is silently never backed up again. Every run therefore re-fetches its outstanding failures by item ID **before** processing new delta changes:

- the item downloads → the record is cleared, and it appears in that run's snapshot;
- the item no longer exists (Graph 404) → the record is dropped silently; there is nothing left to back up;
- it fails again → the attempt count increments and the original `first_failed_at` is preserved.

After **5 attempts** an item stops being re-fetched but keeps being reported on every run, so a permanently broken file costs one line of output instead of a download attempt on every backup forever.

```
[!] Not backed up: Osakasluettelo.xlsx (01STBDHIPIY7N3OWY...) -- file content could not be
    downloaded; will retry (attempt 2 of 5), first failed 2026-08-11T07:58:43.224Z
[x] Status: UNHEALTHY
```

Once the underlying problem clears, the next run picks the file up automatically:

```
[+] Snapshot sp-snap-1786435155739-462686 created
1 changed | 0 stored | 1 dedup
[+] Status: HEALTHY
```

::: tip Reading the signal
`UNHEALTHY` with `will retry` is a warning: the backup is progressing, one file is behind. `PERMANENTLY SKIPPED after 5 attempts` means the file needs a human. Check its permissions, sensitivity label, or whether it is corrupt in the source. Either way the rest of the library keeps being protected, and the exit code stays non-zero so schedulers can alert on it.
:::

### Content the service refuses to serve

Malware-quarantined files are a separate case, and they are detected rather than retried. Atlas selects the Graph `malware` facet in its delta query, so a quarantined item is recognised before any download is attempted:

```
[!] Not backed up: infected.docx (01STBDHIPIY7N3OWY...) -- Quarantined by Microsoft 365 malware
    policy: infected.docx (01STBDHIPIY7N3OWY...); PERMANENTLY SKIPPED by service policy, not
    retried, first failed 2026-08-11T07:58:43.224Z
[x] Status: UNHEALTHY
```

These records never consume the 5-attempt budget, because the budget exists for failures that might still succeed. A quarantine is a policy decision, and no number of retries changes it.

Attempting the download is not merely wasteful, it is actively harmful. Graph refuses quarantined content by aborting the transfer rather than returning a clean 403, and an aborted transfer is indistinguishable from a network fault, so it engages the full Graph retry budget of 12 attempts over roughly 23 minutes. A single quarantined file could hold up an entire library backup for that long, per run. Detecting the facet up front removes that stall.

The file stays reported on every run until it is removed or cleaned in the source, and the run stays `UNHEALTHY`, so an operator can always answer which files are not in the backup and why.

## Snapshot Health Status

Every backup prints a health status at the end:

- **HEALTHY.** All primary file content was backed up successfully across all document libraries. The snapshot and delta cursors are safe to rely on.
- **UNHEALTHY.** One or more critical errors occurred: a file download failure, a library-level crash, an encryption error, or an unexpected version download failure. The affected library's entries are excluded from the manifest and its delta cursor is not advanced. `process.exitCode` is set to `2` (partial run) so CI and monitoring pipelines detect the failure; a hard failure that aborts the run exits `1`.

A version download that fails for an unexpected reason, such as throttling, `403 accessDenied`, or a transient Graph fault, means the file's history is missing from the snapshot. It counts as an error and holds the run **UNHEALTHY** (issue #92). Each failure logs its own line with the Graph status and error code, for example `Version 2.0 of proposal.docx: HTTP 403 -- accessDenied`, and the run summary repeats the count.

Versions the service reports as gone (`404` or `410`, content purged by the site's retention policy) are expected, counted as `unavailable`, and do not affect health. OneNote package accounting and other advisory notes remain **warnings**: they appear as `[!]` lines above the status and leave the exit code at `0`.

## OneNote Notebooks

A OneNote notebook is not a file. Graph returns the notebook root as a driveItem carrying a **`package` facet** (`package.type == "oneNote"`) alongside a `folder` facet, and its actual content as ordinary child files:

| Item                        | Facets                               | Backed up                                                                                                                     |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Notebook root (e.g. `Test`) | `folder` + `package`                 | Treated as a folder. `GET /items/{id}/content` returns **404**, because the root has no content of its own and nothing to store |
| `<Section>.one`             | `file`, MIME `application/msonenote` | Yes, byte-for-byte, like any other file                                                                                       |
| `Open Notebook.onetoc2`     | `file`                               | Yes, byte-for-byte                                                                                                            |

Notebook **content is covered by backups today**: each section file is content-addressed, encrypted, and stored under the notebook's folder path. What the run additionally reports is the notebook itself, because file counters alone cannot answer "did the notebook come through whole?":

```
OneNote notebooks detected: 1 (2 section file(s) backed up as ordinary files).
```

If any section file of a notebook fails while its siblings succeed, the run warns explicitly:

```
OneNote notebook "Test" (/Tietoturva/Test) is INCOMPLETE in this backup:
1 of 2 section file(s) failed (Untitled Section.one).
A partially captured notebook may not open after restore.
```

That warning exists because partial capture is the dangerous case: a `.onetoc2` table of contents stored **without** its sibling `.one` sections looks like a successful backup and restores into a notebook that will not open. Notebook completeness is therefore reported per notebook, never averaged into the run's file totals.

### Coverage and Limits

- **Captured:** every `.one` section file and the `.onetoc2` table of contents, at their current revision, in their original folder path.
- **Reported:** notebook count, section files stored, and an explicit incompleteness warning per notebook.
- **Restore is byte-faithful, notebook reassembly is not guaranteed.** A restored `.onetoc2` was verified byte-identical to the backed-up copy (SHA-256 match over a live tenant restore). What Atlas cannot promise is that dropping those files back produces a notebook a OneNote client will open: the package facet is created by the OneNote service, not by a file upload, so restored sections arrive as ordinary files. Treat notebook restore as "recover the section data", then let OneNote re-import it, and verify before relying on it.
- **Version history for section files is often unavailable.** Graph frequently refuses version downloads for `.one` items; those appear in the run as `version download(s) failed`. The current revision is still stored.
- The notebook root is not stored as a manifest entry, because it has no content. Its path is preserved through its children, so restores land the sections back under the same folder structure.

## CLI Reference

| Command                           | Description                                                   |
| --------------------------------- | ------------------------------------------------------------- |
| `atlas sharepoint backup`         | Back up changed files for a SharePoint site                   |
| `atlas sharepoint restore`        | Restore files from a snapshot to the site                     |
| `atlas sharepoint save`           | Decrypt and save files from a snapshot to a local zip archive |
| `atlas sharepoint list-snapshots` | List all snapshots for a site                                 |
| `atlas sharepoint list-versions`  | List all backed-up versions for a specific file               |
| `atlas sharepoint verify`         | Verify snapshot blob integrity                                |

### `atlas sharepoint backup`

| Flag                 | Description                                     | Default        |
| -------------------- | ----------------------------------------------- | -------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID            | Required       |
| `--full`             | Force full crawl, ignore saved delta state      | `false`        |
| `--include-subsites` | Back up subsites too (one snapshot per subsite) | `false`        |
| `-t, --tenant <id>`  | Tenant identifier                               | Config default |

### `atlas sharepoint restore`

| Flag                        | Description                                          | Default                |
| --------------------------- | ---------------------------------------------------- | ---------------------- |
| `--site <url-or-id>`        | SharePoint site URL or Graph site ID                 | Required               |
| `-s, --snapshot <id>`       | SharePoint snapshot ID                               | Required               |
| `--target-site <url-or-id>` | Restore to a different site                          | Original site          |
| `--destination <path>`      | Folder to restore under, created when missing        | `/Restore-<timestamp>` |
| `--in-place`                | Restore to the original paths                        | `false`                |
| `--name <filename>`         | Rename the restored file; single-file restores only   | Original name          |
| `--file-filter <paths...>`  | Only restore specific files (by ID or path)          | All files              |
| `-c, --conflict <mode>`     | File conflict policy: `replace`, `rename`, or `fail` | `rename`               |
| `-t, --tenant <id>`         | Tenant identifier                                    | Config default         |

### `atlas sharepoint save`

| Flag                       | Description                                  | Default        |
| -------------------------- | -------------------------------------------- | -------------- |
| `--site <url-or-id>`       | SharePoint site URL or Graph site ID         | Required       |
| `-s, --snapshot <id>`      | Snapshot ID to save from                     | Required       |
| `--file-filter <paths...>` | Only save specific files (by ID or path)     | All files      |
| `-O, --output <path>`      | Output zip file path                         | Auto-generated |
| `--skip-verify`            | Skip SHA-256 integrity checks                | `false`        |
| `-t, --tenant <id>`        | Tenant identifier                            | Config default |

### `atlas sharepoint list-snapshots`

| Flag                 | Description                          | Default        |
| -------------------- | ------------------------------------ | -------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID | Required       |
| `-t, --tenant <id>`  | Tenant identifier                    | Config default |

### `atlas sharepoint list-versions`

| Flag                 | Description                          | Default        |
| -------------------- | ------------------------------------ | -------------- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID | Required       |
| `-f, --file <ref>`   | File ID or path to look up           | Required       |
| `-t, --tenant <id>`  | Tenant identifier                    | Config default |

### `atlas sharepoint verify`

| Flag                  | Description                          | Default        |
| --------------------- | ------------------------------------ | -------------- |
| `--site <url-or-id>`  | SharePoint site URL or Graph site ID | Required       |
| `-s, --snapshot <id>` | Snapshot ID to verify                | Required       |
| `-t, --tenant <id>`   | Tenant identifier                    | Config default |

Verification compares digests, not bytes, so each object is decrypted as a stream and hashed incrementally. Nothing is held whole, and a snapshot of multi-gigabyte files verifies in the same working set as a snapshot of small ones.

## Restore

Restored files keep their original created and modified timestamps, carried in the Graph `fileSystemInfo` facet. Authors and sharing permissions are not reconstructed: authors are recorded in the manifest for audit, and permissions are not captured at all. See [What a drive restore rebuilds, and what it cannot](./security.md#what-a-drive-restore-rebuilds-and-what-it-cannot).

```bash
# Restore all files into a fresh Restore-<timestamp> folder in each library
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123

# Restore to a different site
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --target-site https://contoso.sharepoint.com/sites/Staging

# Restore into a folder you name
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --destination /DR-drill

# Put files back exactly where they came from, mixed into live content
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --in-place

# Restore specific files only, replacing existing
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --file-filter /Documents/report.docx /Documents/budget.xlsx -c replace
```

### Where restored files land

A restore creates `Restore-<timestamp>` in each destination library and recreates the original folder structure beneath it, so a file backed up from `/Reports/2026` returns to `/Restore-2026-08-27T10-15-30/Reports/2026`. Deleting that one folder undoes the whole restore.

Before 4.0.0 a restore wrote every file back over its original path. With the default `rename` conflict policy that neither failed nor overwrote; it left a suffixed copy beside each original, scattered through live library content with nothing marking which copy came from a backup. `--in-place` still does exactly that, but it now has to be asked for.

`--destination` names the folder instead of generating one, and is created when missing. `--name` renames a single restored file and is rejected when more than one file matches, so pair it with `--file-filter`. Path length limits apply to the deeper nesting: a file that exceeds one is reported as a skipped item and does not abort the run.

Restore decrypts stored file blobs, verifies SHA-256 checksums, and uploads them back to a site's document libraries via the Graph API. Restoring in place uses each manifest entry's own `drive_id`, so files return to the library they came from. Restoring to another site with `--target-site` re-points every upload at a library of that site, described in [Where a cross-site restore lands](#where-a-cross-site-restore-lands).

Files with `change_type: 'deleted'` or a missing `storage_key` are skipped. Checksum verification runs before upload, and corrupted blobs are skipped with a warning.

| Size        | Strategy                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| **≤ 4 MiB** | Single PUT via `PUT /sites/{site_id}/drives/{drive_id}/items/{parent}:/{name}:/content`                                |
| **> 4 MiB** | Resumable upload session via `createUploadSession` with 10 MiB chunks (3 retries per chunk on 429, 500, 502, 503, 504) |

```typescript
const result = await atlas.sharepoint.restore('site-id', {
  snapshot_id: 'sp-snap-123',
  conflict_behavior: 'rename',
});
console.log(`Restored: ${result.files_restored} files, ${result.folders_created} folders`);
```

### Where a cross-site restore lands

A manifest entry records the `drive_id` of the library it came from, and that id is only meaningful inside the site that owns it. Graph addresses an upload as `/sites/{site}/drives/{drive}/...`, and the drive wins. `--target-site` therefore has to pick a library belonging to the target site, which Atlas does per entry:

1. **Same library name.** The target library whose name matches the one the file was backed up from, compared case-insensitively, in Unicode NFC, ignoring surrounding whitespace. This keeps a multi-library site's structure intact when the names line up on both ends. If _two_ target libraries share that name the choice is ambiguous, so Atlas refuses rather than pick one.
2. **The only library**, and only when the restore comes from a single source library. Library names are localised (a Finnish tenant's default library is `Tiedostot`, an English one's is `Documents`), so a single-library target must not be decided by name. This rule deliberately does _not_ apply when the snapshot spans several libraries: folding them into one destination merges their trees, and two files sharing a path would overwrite each other under `--conflict replace`. Restore those one library at a time with `--file-filter`.
3. **Neither.** Atlas refuses the file, names the candidate libraries, and the run exits non-zero. It never guesses which production library should receive the data, and never falls back to the library the file came from.

If the target site has no document libraries at all, the restore fails before uploading anything.

::: warning Snapshots taken before 2.1.0-beta
Library names were not recorded in older manifests, so rule 1 cannot apply to them. Such a snapshot restores cross-site only when it came from one library and the target has one library; anything else fails by rule 3 rather than choosing a destination. Take a fresh backup to restore by name.
:::

### Saving to a local archive

`atlas sharepoint save` writes a zip archive instead of uploading to Graph. The archive preserves the SharePoint folder hierarchy from document libraries, and files larger than 4 MiB use streaming decryption to avoid holding the full ciphertext in memory.

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 -O ~/Downloads/backup.zip
```

## Verification

`atlas sharepoint verify` loads the manifest for a given site and snapshot, then performs two checks for every entry:

1. **Index consistency.** Confirms the per-file version index (`sharepoint/index/{site_id}/files/{file_id}.json`) has a record with a matching `snapshot_id`.
2. **Blob integrity.** For non-deleted entries with a `storage_key` and `checksum`:
   - Confirms the blob exists in tenant storage.
   - Downloads and decrypts the ciphertext (the GCM authentication tag validates ciphertext integrity against tampering).
   - Recomputes SHA-256 over the plaintext in 64 MiB chunks.
   - Compares the computed hash against the manifest checksum using `timingSafeEqual`, a constant-time comparison that prevents timing attacks.

Deleted entries and entries without storage keys are skipped, because there is no blob to verify.

```bash
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
```

Exit code is `0` when all checked entries pass, `1` when any blob mismatch or index inconsistency is found.

## Status Checking

Check whether a SharePoint site backup is up to date by peeking at Graph delta state. This queries the delta endpoint with the saved delta links from the latest cursor without advancing them, so it does not interfere with the next backup. On the CLI this is `atlas sharepoint status --site <site>`.

```typescript
const status = await atlas.sharepoint.checkStatus('site-id');
console.log(`Up to date: ${status.is_up_to_date}`);
console.log(`Pending changes: ${status.total_pending_changes}`);

for (const lib of status.libraries) {
  console.log(
    `  ${lib.library_name}: ${lib.pending_changes} pending, backed up: ${lib.has_backup}`,
  );
}
```

`checkStatus` returns a `SharePointStatusResult`:

| Field                   | Type                        | Description                                                           |
| ----------------------- | --------------------------- | --------------------------------------------------------------------- |
| `site_id`               | `string`                    | The Graph site ID                                                     |
| `last_backup_at`        | `Date \| undefined`         | Timestamp of the most recent snapshot                                 |
| `last_snapshot_id`      | `string \| undefined`       | ID of the most recent snapshot                                        |
| `total_libraries`       | `number`                    | Number of document libraries discovered                               |
| `libraries`             | `SharePointLibraryStatus[]` | Per-library backup status                                             |
| `is_up_to_date`         | `boolean`                   | `true` if all libraries have been backed up with zero pending changes |
| `total_pending_changes` | `number`                    | Sum of pending changes across all libraries                           |

## Deletion

Per-site and per-snapshot deletion of SharePoint data is available from both adapters: `atlas sharepoint delete --site <site>`, optionally with `-s <snapshot>`, or the SDK methods below.

```typescript
// Erases manifests, blobs, indexes, cursors and staging -- every version of each
const result = await atlas.sharepoint.deleteSiteData('site-id');
console.log(`Deleted: ${result.deleted_objects} objects, ${result.deleted_manifests} manifests`);

// Delete a single snapshot manifest (data blobs are retained for deduplication)
await atlas.sharepoint.deleteSnapshot('site-id', 'sp-snap-123');
```

`deleteSiteData` erases every version of every matching object, so the data is gone rather than hidden behind a delete marker in a versioned bucket, and it includes the staging prefix where an interrupted large-file upload parks content.

When Object Lock retention protects objects, deletion reports retained items separately from generic failures. See [Erasure](/security#erasure) for how the two are told apart.

## Replication

SharePoint snapshots support the same replication workflow as Outlook and OneDrive backups: ciphertext is copied as-is to a secondary S3 target. Alongside data blobs and manifests, replication also copies version index files and delta cursors, so incremental sync resumes correctly after rehydration.

```bash
# Replicate a specific snapshot
atlas replicate --site contoso.sharepoint.com,guid,guid -s sp-snap-123 \
  --target-config ./offsite.json

# Replicate all unreplicated snapshots for a site
atlas replicate --site contoso.sharepoint.com,guid,guid --target-config ./offsite.json

# Disaster recovery: rehydrate from replica
atlas rehydrate --site contoso.sharepoint.com,guid,guid --source-config ./offsite.json
atlas rehydrate --site contoso.sharepoint.com,guid,guid -s sp-snap-123 --source-config ./offsite.json
```

```typescript
const offsite = createStorageTarget({/* ... */});

// Replicate a snapshot
await atlas.sharepoint.replicateSnapshot('site-id', 'sp-snap-123', [offsite]);

// Replicate all unreplicated snapshots
await atlas.sharepoint.replicateAll('site-id', [offsite]);

// Disaster recovery
await atlas.sharepoint.rehydrateSite('site-id', offsite);
await atlas.sharepoint.rehydrateSnapshot('site-id', 'sp-snap-123', offsite);
```

See [Replication](./operations/replication.md) for the full replication architecture and disaster recovery procedures.

## SDK Usage

The SDK exposes SharePoint backup, restore, verification, deletion, status, site discovery, and replication as programmatic methods on `atlas.sharepoint`:

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: 'your-azure-tenant-id',
  clientId: 'app-client-id',
  clientSecret: 'app-client-secret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'minioadmin',
  s3SecretKey: 'minioadmin',
  encryptionPassphrase: 'my-secret-passphrase',
});

// Incremental backup. One result per backed-up site, root first.
const [result] = await atlas.sharepoint.backup('contoso.sharepoint.com,site-guid,web-guid');
console.log(`Snapshot: ${result.snapshot?.snapshot_id}`);
console.log(`Files stored: ${result.summary.files_stored}`);
// With include_subsites unset, the root result warns about subsites it did not cover.
console.log(result.summary.warnings);

// Force full crawl
const full = await atlas.sharepoint.backup('site-id', { force_full: true });

// Include every subsite beneath the site: one snapshot, and one result, per site
const tree = await atlas.sharepoint.backup('site-id', { include_subsites: true });
console.log(`Backed up ${tree.length} site(s)`);

// Verify snapshot integrity
const verify = await atlas.sharepoint.verify('site-id', 'sp-snap-1735689600000-a1b2c3');
if (verify.failed_file_ids.length > 0) {
  console.error('Corrupt files:', verify.failed_file_ids);
}

// Save files to a local zip archive
const saved = await atlas.sharepoint.save('site-id', {
  snapshot_id: 'sp-snap-123',
  output_path: 'sharepoint-backup.zip',
});
console.log(`Saved: ${saved.files_saved} files`);
```

See [Programmatic SDK](./reference/sdk.md) for full method signatures and option types.

### Site discovery

Discover SharePoint sites available for backup, or resolve a specific site by URL:

```typescript
// List all sites in the tenant
const sites = await atlas.sharepoint.listSites();
for (const site of sites) {
  console.log(`${site.displayName}: ${site.webUrl} (${site.id})`);
}

// Resolve a site URL to its Graph site ID
const site = await atlas.sharepoint.resolveSite('https://contoso.sharepoint.com/sites/Engineering');
console.log(site.id);
```

## Differences from OneDrive Backup

| Aspect                       | OneDrive                                          | SharePoint                                                    |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| **Scope**                    | Per-user (owner ID)                               | Per-site (site ID)                                            |
| **Target**                   | User's personal drive                             | All document libraries in a site                              |
| **Storage prefix**           | `onedrive/`                                       | `sharepoint/`                                                 |
| **Identity resolution**      | Email -> Entra object ID via `GET /users/{email}` | Site URL -> Graph site ID via `GET /sites/{hostname}:/{path}` |
| **Delta cursor granularity** | One per drive per user                            | One per document library per site                             |
| **Snapshot ID format**       | `od-snap-<ms>-<hex>`                              | `sp-snap-<ms>-<hex>`                                          |
| **Permissions**              | `Files.Read.All` + `User.Read.All`                | `Sites.Read.All` + `Files.Read.All`                           |

The encryption, content-addressing, streaming, and version-tracking algorithms are identical between OneDrive and SharePoint backup. Only the scope (user versus site) and the Graph API endpoints differ.

For more command-line examples aligned with the rest of the product, see [CLI Commands](./reference/cli.md).
