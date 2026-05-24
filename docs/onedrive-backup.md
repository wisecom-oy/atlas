# OneDrive Backup

Atlas backs up OneDrive files incrementally using Microsoft Graph delta queries. Changed files are encrypted with AES-256-GCM and stored content-addressed in S3-compatible object storage. File version history is preserved across syncs.

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

1. **Delta sync** -- For each drive, Atlas calls `GET /users/{owner_id}/drives/{drive_id}/root/delta` (or follows the stored OData `deltaLink`) to discover changed files since the last backup. Invalid or expired delta tokens trigger a full delta reset on the next attempt. If a single drive fails during a multi-drive backup, its delta link is not advanced and its entries are discarded from the snapshot manifest so the next run retries that drive cleanly. The delta cursor is saved incrementally after each successfully completed drive, reducing the replay window if the process crashes mid-backup. Only changed, moved, renamed, or deleted file items are considered for the manifest.
2. **Content-addressed storage** -- Each file is SHA-256 hashed over the plaintext before encryption. If the same content already exists for that owner, the blob is deduplicated (no second upload).
3. **Zero-disk streaming** -- Files at or above **512 MiB** use `fetch_file_chunks`: 4 MiB download segments are encrypted and assembled into **8 MiB** S3 multipart parts, staged under `onedrive/staging/`, then copied to the canonical `onedrive/data/` key or aborted if the content hash already exists. Peak working set is dominated by one download buffer plus one upload part (on the order of **12 MiB** per large file, not the full file size).
4. **Version history** -- After the current version is processed, Atlas calls `GET /drives/{drive_id}/items/{item_id}/versions` and stores any new historical versions the same way as live content.
5. **Encrypted manifests and sidecars** -- Each backup run that records changes builds a snapshot manifest (entries, checksums, paths). Manifests, per-file version indexes, and delta cursor JSON are encrypted with the tenant DEK on `put`, consistent with the rest of Atlas.

## Storage Layout

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

Ciphertext is stored at the key name shown above; there is no separate `.enc` filename suffix (encryption is applied by the storage layer).

## User Identity Privacy

Atlas stores OneDrive data under **Entra object IDs** (opaque UUIDs). Typical benefits:

- **Breach resilience** -- With a storage-only compromise, object keys and metadata tags refer to Graph file IDs and hashes, not mailbox email addresses in the path.
- **Stability** -- Object IDs are stable when the user's UPN or primary email changes.

If `--owner` contains `@`, the CLI resolves it via `GraphUserIdentityResolver`: `GET /users/{email}` with `select=id,displayName,mail,userPrincipalName`, then uses `id` as `owner_id`. Values **without** `@` are treated as object IDs and passed through unchanged.

Mailbox backup currently keys `data/` and `manifests/` by the mailbox identifier supplied to sync (often the primary SMTP address). OneDrive is intentionally keyed by object ID after resolution so operators should not assume the same string appears in both trees for a given person.

## CLI Reference

| Command | Description |
| --- | --- |
| `atlas onedrive backup` | Back up changed files for one user |
| `atlas onedrive restore` | Restore files from a snapshot |
| `atlas onedrive save` | Decrypt and save files from a snapshot to a local zip archive |
| `atlas onedrive list-snapshots` | List all snapshots for a user |
| `atlas onedrive list-versions` | Show version history for a file |
| `atlas onedrive verify` | Verify snapshot blob integrity |

### `atlas onedrive backup`

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) | — |
| `--full` | Force full crawl, ignore saved delta state | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

### `atlas onedrive restore`

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) | — |
| `-s, --snapshot <id>` | Snapshot to restore from (required) | — |
| `--target-owner <id>` | Restore to a different user's OneDrive | Same as `--owner` |
| `--file-filter <paths...>` | Only restore specific files (by ID or path) | All files |
| `-c, --conflict <mode>` | File conflict policy: `replace`, `rename`, or `fail` | `rename` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

Restored files are uploaded to the target user's primary drive. Folders are created as needed (existing folders with the same name are reused, not overwritten). Each file is decrypted, SHA-256 verified against the manifest checksum, and then uploaded using a small-file PUT (&le; 4 MiB) or a resumable upload session (> 4 MiB, with per-chunk retry on 429/503).

Files larger than 4 MiB use a streaming decrypt pipeline: the encrypted blob is read from S3 as a stream, the first 28 bytes (12-byte IV + 16-byte auth tag) are consumed to initialize AES-256-GCM, and ciphertext is decrypted in chunks without buffering the full ciphertext in memory.

**Conflict behavior** controls what happens when a file already exists at the target path. `rename` (default) appends a numeric suffix to avoid overwriting user edits made after a previous restore. `replace` overwrites the existing file. `fail` skips the file and logs an error.

### `atlas onedrive list-snapshots`

| Flag | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-t, --tenant <id>` | Tenant identifier |

### `atlas onedrive list-versions`

| Flag | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-f, --file <ref>` | File ID or path (required) |
| `-t, --tenant <id>` | Tenant identifier |

### `atlas onedrive save`

| Flag | Description | Default |
| --- | --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) | -- |
| `-s, --snapshot <id>` | Snapshot ID to save from (required) | -- |
| `--file-filter <paths...>` | Only save specific files (by ID or path) | All files |
| `-O, --output <path>` | Output zip file path | Auto-generated |
| `--skip-verify` | Skip SHA-256 integrity checks | `false` |
| `-t, --tenant <id>` | Tenant identifier | Config default |

The zip archive preserves the OneDrive folder hierarchy. Files larger than 4 MiB use streaming decryption to avoid holding the full ciphertext in memory.

```bash
atlas onedrive save -o user@company.com -s od-snap-123
atlas onedrive save -o user@company.com -s od-snap-123 -O ~/Downloads/backup.zip
atlas onedrive save -o user@company.com -s od-snap-123 --file-filter "/Documents/report.docx"
```

### `atlas onedrive verify`

| Flag | Description |
| --- | --- |
| `-o, --owner <id>` | User email or Entra object ID (required) |
| `-s, --snapshot <id>` | Snapshot ID to verify (required) |
| `-t, --tenant <id>` | Tenant identifier |

`atlas onedrive verify` loads the manifest under `onedrive/manifests/{owner_id}/` for the resolved owner and snapshot ID (never listing other owners' prefixes), decrypts each referenced blob, recomputes SHA-256 with `timingSafeEqual`, and checks that the per-file index contains a row for that snapshot.

## Snapshot Health Status

Every backup prints a health status at the end:

- **HEALTHY** -- all primary file content was backed up successfully. The snapshot and delta cursor are safe to rely on.
- **UNHEALTHY** -- one or more critical errors occurred (file download failure, drive-level crash, encryption error). The affected drive's entries are excluded from the manifest and its delta cursor is not advanced. `process.exitCode` is set to `1` so CI/monitoring pipelines detect the failure.

Non-critical issues such as historical version download failures or expired version URLs are reported as **warnings** in the output but do not affect the health status. Warnings appear as `[!]` lines above the status; errors appear indented under `UNHEALTHY`.

## Azure AD Permissions

Add these to your app registration (in addition to the Outlook backup set):

| Permission | Type | Purpose |
| --- | --- | --- |
| `Files.Read.All` | Application | Read all users' OneDrive files (backup, verify) |
| `Files.ReadWrite.All` | Application | Write to OneDrive (restore only) |
| `User.Read.All` | Application | Resolve `users/{email}` to object ID for `-o` |

Outlook backup already expects application permissions such as `Mail.Read` / `Mail.ReadBasic.All`; keep those for mailbox workflows.

## File Size Handling

Implementation thresholds from `@atlas/onedrive`:

| Size | Strategy |
| --- | --- |
| **≤ 4 MiB** | Single read of the file into memory (pre-authenticated URL or Graph content fallback when needed), encrypt, `put` |
| **> 4 MiB** and **< 512 MiB** | Range-based chunked download (`CHUNK_SIZE_BYTES` = 4 MiB), encrypt, `put` |
| **≥ 512 MiB** | `process_large_file`: stream encrypt into multipart upload on staging, complete or abort after dedup check, then server-side copy to `onedrive/data/{owner_id}/{sha256}` |

Chunked downloads retry each **4 MiB** range independently (5 attempts with backoff in the adapter) so a transient failure replays a single chunk instead of the whole file.

## Unicode Path Handling

OneDrive paths and file names from Graph are normalized to **Unicode NFC** in the connector and catalog (`String.prototype.normalize('NFC')`). That aligns macOS (often NFD) with Windows/Linux naming so the same logical path does not produce duplicate index entries after sync.

For more command-line examples aligned with the rest of the product, see [CLI Commands](./reference/cli.md).
