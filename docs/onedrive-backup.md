# OneDrive Backup

Atlas backs up OneDrive files incrementally using Microsoft Graph delta queries. Changed files are encrypted with AES-256-GCM and stored content-addressed in S3-compatible object storage. File version history is preserved across syncs.

Backup is user-targeted: one run processes every drive belonging to a single user. For site document libraries, see [SharePoint Backup](./sharepoint-backup.md).

## What Gets Backed Up

| Item                         | Coverage                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Files in the user's drives   | Current content, SHA-256 content-addressed and deduplicated per owner                                       |
| File version history         | Every new historical version Graph returns for an item                                                      |
| Folder paths                 | Recorded on the manifest entry and normalized to Unicode NFC                                                |
| OneNote notebooks            | Section files and table of contents, stored as ordinary files (see [OneNote Notebooks](#onenote-notebooks)) |
| Moves, renames, and deletions | Recorded as manifest changes on the next delta sync                                                        |

## Prerequisites

Add these application permissions to your app registration, in addition to the Outlook backup set:

| Permission            | Type        | Purpose                                         |
| --------------------- | ----------- | ----------------------------------------------- |
| `Files.Read.All`      | Application | Read all users' OneDrive files (backup, verify) |
| `Files.ReadWrite.All` | Application | Write to OneDrive (restore only)                |
| `User.Read.All`       | Application | Resolve `users/{email}` to object ID for `-o`   |

Outlook backup already expects application permissions such as `Mail.Read` and `Mail.ReadBasic.All`. Keep those for mailbox workflows.

## Quick Start

```bash
# Back up a user's OneDrive (email is resolved to Entra object ID automatically)
atlas onedrive backup -o user@company.com

# Force full sync (ignores saved delta state)
atlas onedrive backup -o user@company.com --full

# List snapshots
atlas onedrive list-snapshots -o user@company.com

# List all backed-up versions of a file
atlas onedrive list-versions -o user@company.com -f "file-id-or-path"

# Verify snapshot integrity
atlas onedrive verify -o user@company.com -s od-snap-1735689600000-a1b2c3
```

New snapshot IDs are generated as `od-snap-<milliseconds>-<6-hex>` (for example `od-snap-1735689600000-a1b2c3`). Use the value printed at the end of a successful backup or from `list-snapshots`.

## How It Works

1. **Delta sync.** For each drive, Atlas calls `GET /users/{owner_id}/drives/{drive_id}/root/delta`, or follows the stored OData `deltaLink`, to discover changed files since the last backup. Invalid or expired delta tokens trigger a full delta reset on the next attempt. A file that fails to download does not discard the rest of the drive: successful entries are kept, the delta link advances, and the failure is recorded for retry (see [Failed Items and Delta Progress](#failed-items-and-delta-progress)). A drive that fails outright, before any delta could be read, leaves its link untouched so the next run retries it cleanly. The delta cursor is saved incrementally after each successfully completed drive, reducing the replay window if the process crashes mid-backup. Only changed, moved, renamed, or deleted file items are considered for the manifest.
2. **Content-addressed storage.** Each file is SHA-256 hashed over the plaintext before encryption. If the same content already exists for that owner, the blob is deduplicated (no second upload).
3. **Zero-disk streaming.** Files at or above **64 MiB** use `fetch_file_chunks`: 4 MiB download segments are encrypted and assembled into **8 MiB** S3 multipart parts, staged under `onedrive/staging/`, then copied to the canonical `onedrive/data/` key or aborted if the content hash already exists. Peak working set is dominated by one download buffer plus one upload part, on the order of **12 MiB** per large file rather than the full file size.
4. **Version history.** After the current version is processed, Atlas calls `GET /drives/{drive_id}/items/{item_id}/versions` and stores any new historical versions the same way as live content, including the streaming threshold: a historical version at or above **64 MiB** streams rather than buffering. A version carries no size limit of its own, so a large file's history is otherwise the easiest way to exhaust the heap.
5. **Encrypted manifests and sidecars.** Each backup run that records changes builds a snapshot manifest (entries, checksums, paths). Manifests, per-file version indexes, and delta cursor JSON are encrypted with the tenant DEK on `put`, consistent with the rest of Atlas.

### Storage Layout

Paths live in the **same per-tenant bucket** as mailbox backup (see [Storage Layout](./operations/storage-layout.md)), under the `onedrive/` prefix:

```
atlas-{tenant_id}/
  onedrive/
    data/{owner_id}/{sha256}              # Encrypted file blobs (content-addressed)
    manifests/{owner_id}/{snapshot_id}.json
    index/{owner_id}/files/{file_id}.json
    staging/{owner_id}/{item_id}-{rand}   # Temporary multipart / dedup staging
    _meta/{owner_id}/delta.json           # Encrypted delta link + path tracking state
```

Object keys use the **Entra object ID** (UUID), not SMTP addresses. The CLI accepts either; resolution is described under [User Identity Privacy](#user-identity-privacy).

Ciphertext is stored at the key name shown above. There is no separate `.enc` filename suffix, because encryption is applied by the storage layer.

### File Size Handling

Implementation thresholds from `@wisecom/atlas-onedrive`:

| Size                          | Strategy                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **≤ 4 MiB**                   | Single read of the file into memory (pre-authenticated URL or Graph content fallback when needed), encrypt, `put`                                                        |
| **> 4 MiB** and **< 64 MiB**  | Range-based chunked download (`CHUNK_SIZE_BYTES` = 4 MiB), encrypt, `put`                                                                                                |
| **≥ 64 MiB**                  | `process_large_file`: stream encrypt into multipart upload on staging, complete or abort after dedup check, then server-side copy to `onedrive/data/{owner_id}/{sha256}` |

Chunked downloads retry each **4 MiB** range independently (5 attempts with backoff in the adapter), so a transient failure replays a single chunk instead of the whole file. Each range request is also aborted if the chunk has not transferred at roughly 256 KB/s, with a floor of 30 seconds. That budget is sized from the chunk being fetched, not the file, so a dead connection costs about 30 seconds and then a retry regardless of whether the file is 5 MB or 5 GB.

### Unicode Path Handling

OneDrive paths and file names from Graph are normalized to **Unicode NFC** in the connector and catalog (`String.prototype.normalize('NFC')`). That aligns macOS (often NFD) with Windows and Linux naming, so the same logical path does not produce duplicate index entries after sync.

## User Identity Privacy

Atlas stores OneDrive data under **Entra object IDs** (opaque UUIDs). Typical benefits:

- **Breach resilience.** With a storage-only compromise, object keys and metadata tags refer to Graph file IDs and hashes, not mailbox email addresses in the path.
- **Stability.** Object IDs are stable when the user's UPN or primary email changes.

If `--owner` contains `@`, the CLI resolves it via `GraphUserIdentityResolver`: `GET /users/{email}` with `select=id,displayName,mail,userPrincipalName`, then uses `id` as `owner_id`. Values **without** `@` are treated as object IDs and passed through unchanged.

Mailbox backup currently keys `data/` and `manifests/` by the mailbox identifier supplied to sync, often the primary SMTP address. OneDrive is intentionally keyed by object ID after resolution, so operators should not assume the same string appears in both trees for a given person.

### Identifier Case

Object IDs, mailbox addresses, and SharePoint site IDs are all case-insensitive to Microsoft Graph and case-sensitive to S3, so Atlas lowercases them before they become key segments. Two spellings of one identifier therefore address one tree.

This matters most for deletion. Before 2.1.0-beta, `deleteOwnerData` given an uppercase object ID swept an empty prefix, reported the objects it deleted there, and left the real data untouched. That is an erasure that reported success while every byte stayed retrievable. Graph returns these identifiers lowercase, so the gap only opened for callers supplying their own: an operator pasting an object ID from a portal, or an SDK embedder holding one in application state.

Graph **item** IDs (`file_id`, `item_id`) are genuinely case-sensitive and are never folded. `--file-filter` accepts them exactly as a listing prints them, and compares case-insensitively so a retyped ID still matches.

## Scoping a backup to one folder

`atlas onedrive backup` covers the owner's whole drive by default. `--folder` narrows it to one subtree:

```bash
atlas onedrive backup -o user@company.com --folder /Projects
```

This matters on large accounts. Because the default is the whole drive, a backup's runtime and cost scale with everything the user keeps in OneDrive, including content nobody intends to archive. Scoping to the folders that matter keeps a run proportional to the data you actually want.

Graph's drive delta is drive-wide, so the scope is applied to the delta result rather than pushed into the query. The run still enumerates the whole drive, but nothing outside the folder is downloaded, hashed, version-synced or written, which is where the time and the Graph quota go.

Two behaviours to know before scheduling scoped runs:

- **Changing the scope forces a full re-crawl.** A delta link records how far the drive was consumed, not how far the folder was, so resuming one under a different scope would permanently skip changes the previous run filtered out. Switching between scoped and unscoped does the same. Runs that repeat the same scope stay incremental, and the scope in force is recorded in the delta cursor.
- **A scoped snapshot holds only that folder.** Restoring it restores only those files. Scoped backups are not a cheaper substitute for a whole-drive backup unless the scope covers everything you need recovered.

## Failed Items and Delta Progress

A file that refuses to download, whether from a permissions quirk, a corrupted item, IRM-protected content, or a chronically 4xx-ing CDN link, must not be able to stop the rest of the drive from being backed up. Atlas therefore **advances past per-item failures and records them**, rather than discarding the batch:

1. Items that succeeded are kept and land in the snapshot.
2. The delta link advances, so the next run picks up new changes instead of replaying the whole backlog.
3. Each failure is written into the drive's delta cursor as a `failed_items` record: item id, name, reason, attempt count, and when it first failed.
4. The run is reported **UNHEALTHY** (non-zero exit) for as long as any failure is outstanding.

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
[+] Snapshot od-snap-1786435155739-462686 created
1 changed | 0 stored | 1 dedup
[+] Status: HEALTHY
```

::: tip Reading the signal
`UNHEALTHY` with `will retry` is a warning: the backup is progressing, one file is behind. `PERMANENTLY SKIPPED after 5 attempts` means the file needs a human. Check its permissions, sensitivity label, or whether it is corrupt in the source. Either way the rest of the drive keeps being protected, and the exit code stays non-zero so schedulers can alert on it.
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

Attempting the download is not merely wasteful, it is actively harmful. Graph refuses quarantined content by aborting the transfer rather than returning a clean 403, and an aborted transfer is indistinguishable from a network fault, so it engages the full Graph retry budget of 12 attempts over roughly 23 minutes. A single quarantined file could hold up an entire drive backup for that long, per run. Detecting the facet up front removes that stall.

The file stays reported on every run until it is removed or cleaned in the source, and the run stays `UNHEALTHY`, so an operator can always answer which files are not in the backup and why.

## Snapshot Health Status

Every backup prints a health status at the end:

- **HEALTHY.** All primary file content was backed up successfully. The snapshot and delta cursor are safe to rely on.
- **UNHEALTHY.** One or more critical errors occurred: a file download failure, a drive-level crash, an encryption error, or an unexpected version download failure. The affected drive's entries are excluded from the manifest and its delta cursor is not advanced. `process.exitCode` is set to `2` (partial run) so CI and monitoring pipelines detect the failure; a hard failure that aborts the run exits `1`.

A version download that fails for an unexpected reason, such as throttling, `403 accessDenied`, or a transient Graph fault, means the file's history is missing from the snapshot. It counts as an error and holds the run **UNHEALTHY** (issue #92). Each failure logs its own line with the Graph status and error code, for example `Version 2.0 of report.docx: HTTP 403 -- accessDenied`, and the run summary repeats the count.

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

| Command                         | Description                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| `atlas onedrive backup`         | Back up changed files for one user                            |
| `atlas onedrive restore`        | Restore files from a snapshot                                 |
| `atlas onedrive save`           | Decrypt and save files from a snapshot to a local zip archive |
| `atlas onedrive list-snapshots` | List all snapshots for a user                                 |
| `atlas onedrive list-versions`  | Show version history for a file                               |
| `atlas onedrive verify`         | Verify snapshot blob integrity                                |

### `atlas onedrive backup`

| Flag                | Description                                | Default        |
| ------------------- | ------------------------------------------ | -------------- |
| `-o, --owner <id>`  | User email or Entra object ID              | Required       |
| `--full`            | Force full crawl, ignore saved delta state | `false`        |
| `-t, --tenant <id>` | Tenant identifier                          | Config default |

### `atlas onedrive restore`

| Flag                       | Description                                          | Default                    |
| -------------------------- | ---------------------------------------------------- | -------------------------- |
| `-o, --owner <id>`         | User email or Entra object ID                        | Required                   |
| `-s, --snapshot <id>`      | Snapshot to restore from                             | Required                   |
| `--target-owner <id>`      | Restore to a different user's OneDrive               | Same as `--owner`          |
| `--destination <path>`     | Folder to restore under, created when missing        | `/Restore-<timestamp>`     |
| `--in-place`               | Restore to the original paths                        | `false`                    |
| `--name <filename>`        | Rename the restored file; single-file restores only  | Original name              |
| `--file-filter <paths...>` | Only restore specific files (by ID or path)          | All files                  |
| `-c, --conflict <mode>`    | File conflict policy: `replace`, `rename`, or `fail` | `rename`                   |
| `-t, --tenant <id>`        | Tenant identifier                                    | Config default             |

### `atlas onedrive save`

| Flag                       | Description                              | Default        |
| -------------------------- | ---------------------------------------- | -------------- |
| `-o, --owner <id>`         | User email or Entra object ID            | Required       |
| `-s, --snapshot <id>`      | Snapshot ID to save from                 | Required       |
| `--file-filter <paths...>` | Only save specific files (by ID or path) | All files      |
| `-O, --output <path>`      | Output zip file path                     | Auto-generated |
| `--skip-verify`            | Skip SHA-256 integrity checks            | `false`        |
| `-t, --tenant <id>`        | Tenant identifier                        | Config default |

### `atlas onedrive list-snapshots`

| Flag                | Description                   | Default        |
| ------------------- | ----------------------------- | -------------- |
| `-o, --owner <id>`  | User email or Entra object ID | Required       |
| `-t, --tenant <id>` | Tenant identifier             | Config default |

### `atlas onedrive list-versions`

| Flag                | Description                   | Default        |
| ------------------- | ----------------------------- | -------------- |
| `-o, --owner <id>`  | User email or Entra object ID | Required       |
| `-f, --file <ref>`  | File ID or path               | Required       |
| `-t, --tenant <id>` | Tenant identifier             | Config default |

### `atlas onedrive verify`

| Flag                  | Description                   | Default        |
| --------------------- | ----------------------------- | -------------- |
| `-o, --owner <id>`    | User email or Entra object ID | Required       |
| `-s, --snapshot <id>` | Snapshot ID to verify         | Required       |
| `-t, --tenant <id>`   | Tenant identifier             | Config default |

Verification compares digests, not bytes, so each object is decrypted as a stream and hashed incrementally. Nothing is held whole, and a snapshot of multi-gigabyte files verifies in the same working set as a snapshot of small ones.

## Restore

Restored files keep their original created and modified timestamps, carried in the Graph `fileSystemInfo` facet. Authors and sharing permissions are not reconstructed: authors are recorded in the manifest for audit, and permissions are not captured at all. See [What a drive restore rebuilds, and what it cannot](./security.md#what-a-drive-restore-rebuilds-and-what-it-cannot).

```bash
# Restore a whole snapshot into a fresh Restore-<timestamp> folder
atlas onedrive restore -o user@company.com -s od-snap-123

# Restore into another user's OneDrive
atlas onedrive restore -o user@company.com -s od-snap-123 --target-owner other@company.com

# Restore into a folder you name
atlas onedrive restore -o user@company.com -s od-snap-123 --destination /DR-drill

# Put files back exactly where they came from, mixed into live content
atlas onedrive restore -o user@company.com -s od-snap-123 --in-place

# Restore one file under a new name
atlas onedrive restore -o user@company.com -s od-snap-123 \
  --file-filter "/Documents/report.docx" --name report-2026-08.docx
```

### Where restored files land

A restore creates `/Restore-<timestamp>` at the target drive root and recreates the original folder structure beneath it. A file backed up from `/Projects/2026/Report.docx` restores to `/Restore-2026-08-27T10-15-30/Projects/2026/Report.docx`. The timestamp format matches the Outlook restore folder, so the two workloads read alike.

This exists because the conflict policy is not a safety net. With the default `rename`, restoring a snapshot whose files still exist neither fails nor overwrites; it writes a suffixed copy next to every original. Repeated across a few DR rehearsals that leaves copies of the same file interleaved with real data, with nothing marking which is which. A restore root makes the result reviewable before it matters and reversible afterwards: delete the folder and the restore is undone.

`--destination` replaces the generated root with one you name, created if missing. `--in-place` restores to the original paths, which was the behaviour before 4.0.0 and is now opt-in. `--conflict` keeps its meaning and applies inside whichever destination is chosen; under a fresh root there is normally nothing to collide with.

`--name` renames a single restored file and is rejected when the restore resolves to more than one file, since renaming many files to one name would either collide or silently rename only the first. Pair it with `--file-filter`.

Nesting the original structure under a restore root lengthens every path, and OneDrive enforces a path length limit. A file that exceeds it is reported as a skipped item with the reason and does not abort the run.

Restored files are uploaded to the target user's primary drive. Folders are created as needed, and existing folders with the same name are reused rather than overwritten. Each file is decrypted, SHA-256 verified against the manifest checksum, and then uploaded using a small-file PUT (&le; 4 MiB) or a resumable upload session (> 4 MiB, with per-chunk retry on any transient Graph status: 429, 500, 502, 503, 504). A range PUT is addressed by its `Content-Range`, so a replayed chunk rewrites the same bytes rather than appending them twice.

Files larger than 4 MiB use a streaming decrypt pipeline: the encrypted blob is read from S3 as a stream, the first 28 bytes (12-byte IV + 16-byte auth tag) are consumed to initialize AES-256-GCM, and ciphertext is decrypted in chunks without buffering the full ciphertext in memory.

**Conflict behavior** controls what happens when a file already exists at the target path:

| Mode                | Behavior                                                                              |
| ------------------- | --------------------------------------------------------------------------------------- |
| `rename` (default)  | Appends a numeric suffix, so user edits made after a previous restore are not overwritten |
| `replace`           | Overwrites the existing file                                                            |
| `fail`              | Skips the file and logs an error                                                        |

### Saving to a local archive

`atlas onedrive save` writes a zip archive instead of uploading to Graph. The archive preserves the OneDrive folder hierarchy, and files larger than 4 MiB use streaming decryption to avoid holding the full ciphertext in memory.

```bash
atlas onedrive save -o user@company.com -s od-snap-123
atlas onedrive save -o user@company.com -s od-snap-123 -O ~/Downloads/backup.zip
atlas onedrive save -o user@company.com -s od-snap-123 --file-filter "/Documents/report.docx"
```

## Verification

`atlas onedrive verify` loads the manifest under `onedrive/manifests/{owner_id}/` for the resolved owner and snapshot ID, never listing other owners' prefixes, then for each entry:

1. Decrypts the referenced blob (the GCM authentication tag validates ciphertext integrity against tampering).
2. Recomputes SHA-256 over the plaintext and compares it to the manifest checksum with `timingSafeEqual`, a constant-time comparison that prevents timing attacks.
3. Checks that the per-file index contains a row for that snapshot.

```bash
atlas onedrive verify -o user@company.com -s od-snap-1735689600000-a1b2c3
```

## Status Checking

Check whether a OneDrive backup is up to date by peeking at Graph delta state. This queries the delta endpoint with the saved delta links from the latest cursor without advancing them, so it does not interfere with the next backup. On the CLI this is `atlas onedrive status -o <owner>`.

```typescript
const status = await atlas.onedrive.checkStatus('owner-id');
console.log(`Up to date: ${status.is_up_to_date}`);
console.log(`Pending changes: ${status.total_pending_changes}`);

for (const drive of status.drives) {
  console.log(
    `  ${drive.drive_name}: ${drive.pending_changes} pending, backed up: ${drive.has_backup}`,
  );
}
```

`checkStatus` returns an `OneDriveStatusResult`:

| Field                   | Type                    | Description                                                        |
| ----------------------- | ----------------------- | ------------------------------------------------------------------ |
| `owner_id`              | `string`                | The user's Entra object ID                                         |
| `last_backup_at`        | `Date \| undefined`     | Timestamp of the most recent snapshot                              |
| `last_snapshot_id`      | `string \| undefined`   | ID of the most recent snapshot                                     |
| `total_drives`          | `number`                | Number of drives discovered                                        |
| `drives`                | `OneDriveDriveStatus[]` | Per-drive backup status                                            |
| `is_up_to_date`         | `boolean`               | `true` if all drives have been backed up with zero pending changes |
| `total_pending_changes` | `number`                | Sum of pending changes across all drives                           |

## Deletion

Per-owner and per-snapshot deletion of OneDrive data is available from both adapters: `atlas onedrive delete -o <owner>`, optionally with `-s <snapshot>`, or the SDK methods below. For a tenant-wide wipe across every workload, use `atlas delete --purge`.

```typescript
// Erases manifests, blobs, indexes, cursors and staging -- every version of each
const result = await atlas.onedrive.deleteOwnerData('owner-id');
console.log(`Deleted: ${result.deleted_objects} objects, ${result.deleted_manifests} manifests`);

// Delete a single snapshot manifest (data blobs are retained for deduplication)
await atlas.onedrive.deleteSnapshot('owner-id', 'od-snap-123');
```

`deleteOwnerData` takes the owner's Entra object ID, the same identifier the storage keys use, which `atlas.resolveUser(email)` returns for an address. It erases every version of every matching object, so the data is gone rather than hidden behind a delete marker in a versioned bucket, and it includes the staging prefix where an interrupted large-file upload parks content.

When Object Lock retention protects objects, deletion reports retained items separately from generic failures. See [Erasure](/security#erasure) for how the two are told apart.

## Replication

OneDrive snapshots support the same replication workflow as Outlook and SharePoint backups: ciphertext is copied as-is to a secondary S3 target. Alongside data blobs and manifests, replication also copies version index files and delta cursors, so incremental sync resumes correctly after rehydration.

```typescript
const offsite = createStorageTarget({/* ... */});

// Replicate a snapshot
await atlas.onedrive.replicateSnapshot('owner-id', 'od-snap-123', [offsite]);

// Replicate all unreplicated snapshots for a user
await atlas.onedrive.replicateAll('owner-id', [offsite]);

// Disaster recovery
await atlas.onedrive.rehydrateOwner('owner-id', offsite);
await atlas.onedrive.rehydrateSnapshot('owner-id', 'od-snap-123', offsite);
```

See [Replication](./operations/replication.md) for the full replication architecture and disaster recovery procedures.

## SDK Usage

The SDK exposes OneDrive backup, restore, verification, deletion, status, and replication as programmatic methods on `atlas.onedrive`:

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

// Incremental backup
const result = await atlas.onedrive.backup('owner-id');
console.log(`Snapshot: ${result.snapshot?.snapshot_id}`);

// Force full crawl
const full = await atlas.onedrive.backup('owner-id', { force_full: true });

// Verify snapshot integrity
const verify = await atlas.onedrive.verify('owner-id', 'od-snap-123');

// Check backup status (fast delta peek)
const status = await atlas.onedrive.checkStatus('owner-id');

// Delete all data for a user
const deletion = await atlas.onedrive.deleteOwnerData('owner-id');

// Replicate and rehydrate
const offsite = createStorageTarget({/* ... */});
await atlas.onedrive.replicateAll('owner-id', [offsite]);
await atlas.onedrive.rehydrateOwner('owner-id', offsite);
```

See [Programmatic SDK](./reference/sdk.md) for full method signatures and option types.

For more command-line examples aligned with the rest of the product, see [CLI Commands](./reference/cli.md).
