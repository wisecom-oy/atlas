# SharePoint Backup

Atlas backs up SharePoint document library files incrementally using Microsoft Graph delta queries. Changed files are encrypted with AES-256-GCM and stored content-addressed in S3-compatible object storage. File version history is preserved across syncs. Unlike OneDrive backup (which is user-targeted), SharePoint backup is **site-targeted** -- each backup run processes all document libraries within a single SharePoint site.

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

1. **Site resolution** -- The `--site` flag accepts either a SharePoint site URL (`https://contoso.sharepoint.com/sites/Engineering`) or a Graph site ID (`contoso.sharepoint.com,site-guid,web-guid`). URLs are resolved via `GET /sites/{hostname}:/{path}` to obtain the canonical site ID used for all storage keys.
2. **Library discovery** -- Atlas calls `GET /sites/{site_id}/drives?$filter=driveType eq 'documentLibrary'` to discover all document libraries within the site. Each library has its own delta cursor, allowing independent incremental tracking.
3. **Delta sync** -- For each document library, Atlas follows `GET /drives/{drive_id}/root/delta` (or the stored OData `deltaLink`) to discover changed files since the last backup. Invalid or expired delta tokens trigger a full delta reset on the next attempt. If a single library fails, its delta link is not advanced and its entries are discarded from the snapshot manifest so the next run retries that library cleanly. The delta cursor is saved incrementally after each successfully completed library.
4. **Content-addressed storage** -- Each file is SHA-256 hashed over the plaintext before encryption. If the same content already exists for that site, the blob is deduplicated (no second upload).
5. **Zero-disk streaming** -- Files at or above **512 MiB** use a streaming pipeline: 4 MiB download segments are encrypted and assembled into **8 MiB** S3 multipart parts, staged under `sharepoint/staging/`, then copied to the canonical `sharepoint/data/` key or aborted if the content hash already exists. Peak working set is dominated by one download buffer plus one upload part (on the order of **12 MiB** per large file, not the full file size).
6. **Version history** -- After the current version is processed, Atlas calls `GET /drives/{drive_id}/items/{item_id}/versions` and stores any new historical versions the same way as live content.
7. **Encrypted manifests and sidecars** -- Each backup run that records changes builds a snapshot manifest (entries, checksums, paths). Manifests, per-file version indexes, and delta cursor JSON are encrypted with the tenant DEK on `put`, consistent with the rest of Atlas.

## Deterministic Error Handling

SharePoint backup enforces **all-or-nothing semantics per document library**. If any file within a library fails to process:

- All entries from that library are discarded from the snapshot manifest.
- The delta cursor for that library is **not** advanced, so the next run will retry the full delta for that library.
- The overall backup result is marked **UNHEALTHY**.
- Healthy libraries in the same site are **not** affected -- their entries are included normally and their cursors are advanced.

This prevents partial states where some files appear successfully backed up in the manifest but their processing was incomplete.

## Storage Layout

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

Object keys use the **Graph site ID** (e.g. `contoso.sharepoint.com,aaa-bbb,ccc-ddd`). The CLI resolves site URLs to site IDs automatically.

Ciphertext is stored at the key name shown above; there is no separate `.enc` filename suffix (encryption is applied by the storage layer).

## Verification

`atlas sharepoint verify` loads the manifest for a given site and snapshot, then performs two checks for every entry:

1. **Index consistency** -- Confirms the per-file version index (`sharepoint/index/{site_id}/files/{file_id}.json`) has a record with a matching `snapshot_id`.
2. **Blob integrity** -- For non-deleted entries with a `storage_key` and `checksum`:
   - Confirms the blob exists in tenant storage.
   - Downloads and decrypts the ciphertext (the GCM authentication tag validates ciphertext integrity against tampering).
   - Recomputes SHA-256 over the plaintext in 64 MiB chunks.
   - Compares the computed hash against the manifest checksum using `timingSafeEqual` (constant-time comparison to prevent timing attacks).

Deleted entries and entries without storage keys are skipped (no blob to verify).

```bash
atlas sharepoint verify --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-1735689600000-a1b2c3
```

Exit code is `0` when all checked entries pass, `1` when any blob mismatch or index inconsistency is found.

## SDK Usage

The SDK exposes SharePoint backup and verification as programmatic methods on `atlas.sharepoint`:

```typescript
import { createAtlasInstance } from '@atlas/sdk';

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
const result = await atlas.sharepoint.backup('contoso.sharepoint.com,site-guid,web-guid');
console.log(`Snapshot: ${result.snapshot?.snapshot_id}`);
console.log(`Files stored: ${result.summary.files_stored}`);

// Force full crawl
const full = await atlas.sharepoint.backup('site-id', { force_full: true });

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

## Status Checking

Check whether a SharePoint site backup is up to date by peeking at Graph delta state. This queries the delta endpoint with the saved delta links from the latest cursor without advancing them, so it does not interfere with the next backup.

**SDK:**

```typescript
const status = await atlas.sharepoint.checkStatus('site-id');
console.log(`Up to date: ${status.is_up_to_date}`);
console.log(`Pending changes: ${status.total_pending_changes}`);

for (const lib of status.libraries) {
  console.log(`  ${lib.library_name}: ${lib.pending_changes} pending, backed up: ${lib.has_backup}`);
}
```

`checkStatus` returns a `SharePointStatusResult`:

| Field | Type | Description |
| --- | --- | --- |
| `site_id` | `string` | The Graph site ID |
| `last_backup_at` | `Date \| undefined` | Timestamp of the most recent snapshot |
| `last_snapshot_id` | `string \| undefined` | ID of the most recent snapshot |
| `total_libraries` | `number` | Number of document libraries discovered |
| `libraries` | `SharePointLibraryStatus[]` | Per-library backup status |
| `is_up_to_date` | `boolean` | `true` if all libraries have been backed up with zero pending changes |
| `total_pending_changes` | `number` | Sum of pending changes across all libraries |

## Deletion

Delete backed-up SharePoint data via the SDK. Per-site and per-snapshot deletion is available through the programmatic API.

**SDK:**

```typescript
// Delete all backed-up data for a site (manifests, blobs, indexes, cursors)
const result = await atlas.sharepoint.deleteSiteData('site-id');
console.log(`Deleted: ${result.deleted_objects} objects, ${result.deleted_manifests} manifests`);

// Delete a single snapshot manifest (data blobs are retained for deduplication)
await atlas.sharepoint.deleteSnapshot('site-id', 'sp-snap-123');
```

When Object Lock retention protects objects, deletion reports retained items separately from generic failures.

## Site Discovery

Discover SharePoint sites available for backup or resolve a specific site by URL:

**SDK:**

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

## CLI Reference

| Command | Description |
| --- | --- |
| `atlas sharepoint backup` | Back up changed files for a SharePoint site |
| `atlas sharepoint list-snapshots` | List all snapshots for a site |
| `atlas sharepoint list-versions` | List all backed-up versions for a specific file |
| `atlas sharepoint restore` | Restore files from a snapshot to the site |
| `atlas sharepoint save` | Decrypt and save files from a snapshot to a local zip archive |
| `atlas sharepoint verify` | Verify snapshot blob integrity |

### `atlas sharepoint backup`

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) | -- |
| `--full` | Force full crawl, ignore saved delta state | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

### `atlas sharepoint list-snapshots`

| Flag | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-t, --tenant <id>` | Tenant identifier |

### `atlas sharepoint list-versions`

| Flag | Description |
| --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) |
| `-f, --file <ref>` | File ID or path to look up (required) |
| `-t, --tenant <id>` | Tenant identifier |

### `atlas sharepoint restore`

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) | -- |
| `-s, --snapshot <id>` | SharePoint snapshot ID (required) | -- |
| `--target-site <url-or-id>` | Restore to a different site | Original site |
| `--file-filter <paths...>` | Only restore specific files (by ID or path) | All files |
| `-c, --conflict <mode>` | File conflict policy: `replace`, `rename`, or `fail` | `rename` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

### `atlas sharepoint save`

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) | -- |
| `-s, --snapshot <id>` | Snapshot ID to save from (required) | -- |
| `--file-filter <paths...>` | Only save specific files (by ID or path) | All files |
| `-O, --output <path>` | Output zip file path | Auto-generated |
| `--skip-verify` | Skip SHA-256 integrity checks | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

The zip archive preserves the SharePoint folder hierarchy from document libraries. Files larger than 4 MiB use streaming decryption to avoid holding the full ciphertext in memory.

```bash
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123
atlas sharepoint save --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 -O ~/Downloads/backup.zip
```

### `atlas sharepoint verify`

| Flag | Description | Default |
| --- | --- | --- |
| `--site <url-or-id>` | SharePoint site URL or Graph site ID (required) | -- |
| `-s, --snapshot <id>` | Snapshot ID to verify (required) | -- |
| `-t, --tenant <id>` | Tenant identifier | Config default |

## Snapshot Health Status

Every backup prints a health status at the end:

- **HEALTHY** -- all primary file content was backed up successfully across all document libraries. The snapshot and delta cursors are safe to rely on.
- **UNHEALTHY** -- one or more critical errors occurred (file download failure, library-level crash, encryption error). The affected library's entries are excluded from the manifest and its delta cursor is not advanced. `process.exitCode` is set to `1` so CI/monitoring pipelines detect the failure.

Non-critical issues such as historical version download failures or expired version URLs are reported as **warnings** in the output but do not affect the health status. Warnings appear as `[!]` lines above the status; errors appear indented under `UNHEALTHY`.

## Azure AD Permissions

Add these to your app registration (in addition to any existing Outlook or OneDrive backup permissions):

| Permission | Type | Purpose |
| --- | --- | --- |
| `Sites.Read.All` | Application | List sites and read document library metadata |
| `Files.Read.All` | Application | Read file content from document libraries (backup, verify) |

SharePoint backup requires only read permissions (`Sites.Read.All`, `Files.Read.All`). Restore additionally requires `Sites.ReadWrite.All` to upload files back to the site.

## File Size Handling

Implementation thresholds from `@atlas/sharepoint`:

| Size | Strategy |
| --- | --- |
| **<= 4 MiB** | Single read via pre-authenticated URL (with 429 retry + Retry-After backoff) or Graph content fallback, encrypt, `put` |
| **> 4 MiB** and **< 512 MiB** | Range-based chunked download (`CHUNK_SIZE_BYTES` = 4 MiB), encrypt, `put` |
| **>= 512 MiB** | Streaming pipeline: chunk download into streaming encrypt into multipart upload on staging, complete or abort after dedup check, then server-side copy to `sharepoint/data/{site_id}/{sha256}` |

Chunked downloads retry each **4 MiB** range independently (5 attempts with exponential backoff) so a transient failure replays a single chunk instead of the whole file.

## Download Resilience

SharePoint's direct download URLs (pre-authenticated CDN links via `@microsoft.graph.downloadUrl`) are subject to Microsoft Graph rate limiting. Atlas handles this with:

- **429 detection** on direct download URLs with `Retry-After` header parsing (supports both delta-seconds and HTTP-date formats).
- **Exponential backoff** when `Retry-After` is absent (base 1s, max 32s, with jitter).
- **Graph content fallback** -- if the pre-authenticated URL fails after retries, Atlas falls back to `GET /drives/{drive_id}/items/{item_id}/content` which routes through the Graph gateway rather than the CDN.

## Restore

Restore decrypts stored file blobs, verifies SHA-256 checksums, and uploads them back to the site's document libraries via Graph API. Each manifest entry carries its own `drive_id`, so files are restored to the correct document library automatically.

**CLI:**

```bash
# Restore all files from a snapshot
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123

# Restore to a different site
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --target-site https://contoso.sharepoint.com/sites/Staging

# Restore specific files only, replacing existing
atlas sharepoint restore --site https://contoso.sharepoint.com/sites/Engineering -s sp-snap-123 \
  --file-filter /Documents/report.docx /Documents/budget.xlsx -c replace
```

**SDK:**

```typescript
const result = await atlas.sharepoint.restore('site-id', {
  snapshot_id: 'sp-snap-123',
  conflict_behavior: 'rename',
});
console.log(`Restored: ${result.files_restored} files, ${result.folders_created} folders`);
```

**File size handling during restore:**

| Size | Strategy |
| --- | --- |
| **<= 4 MiB** | Single PUT via `PUT /sites/{site_id}/drives/{drive_id}/items/{parent}:/{name}:/content` |
| **> 4 MiB** | Resumable upload session via `createUploadSession` with 10 MiB chunks (3 retries per chunk on 429/503) |

Files with `change_type: 'deleted'` or missing `storage_key` are skipped. Checksum verification runs before upload -- corrupted blobs are skipped with a warning.

## Replication

SharePoint snapshots support the same replication workflow as Outlook backups -- ciphertext is copied as-is to a secondary S3 target. In addition to data blobs and manifests, replication also copies version index files and delta cursors so that incremental sync resumes correctly after rehydration.

**CLI:**

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

**SDK:**

```typescript
const offsite = createStorageTarget({ /* ... */ });

// Replicate a snapshot
await atlas.sharepoint.replicateSnapshot('site-id', 'sp-snap-123', [offsite]);

// Replicate all unreplicated snapshots
await atlas.sharepoint.replicateAll('site-id', [offsite]);

// Disaster recovery
await atlas.sharepoint.rehydrateSite('site-id', offsite);
await atlas.sharepoint.rehydrateSnapshot('site-id', 'sp-snap-123', offsite);
```

See [Replication](./operations/replication.md) for the full replication architecture and disaster recovery procedures.

## Differences from OneDrive Backup

| Aspect | OneDrive | SharePoint |
| --- | --- | --- |
| **Scope** | Per-user (owner ID) | Per-site (site ID) |
| **Target** | User's personal drive | All document libraries in a site |
| **Storage prefix** | `onedrive/` | `sharepoint/` |
| **Identity resolution** | Email -> Entra object ID via `GET /users/{email}` | Site URL -> Graph site ID via `GET /sites/{hostname}:/{path}` |
| **Delta cursor granularity** | One per drive per user | One per document library per site |
| **Snapshot ID format** | `od-snap-<ms>-<hex>` | `sp-snap-<ms>-<hex>` |
| **Permissions** | `Files.Read.All` + `User.Read.All` | `Sites.Read.All` + `Files.Read.All` |

The encryption, content-addressing, streaming, and version-tracking algorithms are identical between OneDrive and SharePoint backup -- only the scope (user vs. site) and Graph API endpoints differ.

For more command-line examples aligned with the rest of the product, see [CLI Commands](./reference/cli.md).
