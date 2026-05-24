# Programmatic SDK

Atlas can be used as a typed library in other Node.js applications. The SDK is available as a separate subpath import.

## Installation

```bash
npm add m365-atlas
```

## Creating an Instance

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({
  tenantId: 'your-azure-tenant-id',
  clientId: 'app-client-id',
  clientSecret: 'app-client-secret',
  s3Endpoint: 'http://localhost:9000',
  s3AccessKey: 'minioadmin',
  s3SecretKey: 'minioadmin',
  encryptionPassphrase: 'my-secret-passphrase',
});
```

All config is explicit -- the SDK **does not read environment variables or config files**. This is a deliberate security choice for multi-tenant environments: there is no risk of accidentally picking up credentials from a stale `.env` file or inheriting environment variables meant for a different tenant. Every value is passed explicitly at construction time.

The tenant is bound at creation time, so every method operates within that tenant scope.

The SDK uses standard ES6 camelCase naming. All methods are async and return Promises.

## Available Methods

The SDK exposes a nested API: workload-specific methods live under `outlook`, `onedrive`, and `sharepoint`; cross-cutting storage and replication methods stay at the root.

```typescript
// Outlook: backup a single mailbox
const result = await atlas.outlook.backup('user@company.com', { force_full: true });

// Outlook: list backed-up mailboxes
const mailboxes = await atlas.outlook.listMailboxes();

// Outlook: verify snapshot integrity
const verification = await atlas.outlook.verify('snapshot-id');

// OneDrive: backup user's drive
const odResult = await atlas.onedrive.backup('owner-id');

// SharePoint: backup a site
const spResult = await atlas.sharepoint.backup('site-id');

// Cross-cutting: check storage
const check = await atlas.checkStorage();
```

## Outlook Methods

All mailbox operations are scoped under `atlas.outlook`.

```typescript
// backup a single mailbox (long-running)
const result = await atlas.outlook.backup('user@company.com', { force_full: true });

// verify snapshot integrity
const verification = await atlas.outlook.verify('snapshot-id');

// restore from a specific snapshot (long-running)
const restore = await atlas.outlook.restore('snapshot-id', { folder_name: 'Inbox' });

// restore all snapshots for a mailbox (long-running)
const fullRestore = await atlas.outlook.restoreMailbox('user@company.com');

// save snapshot as EML zip archive
const save = await atlas.outlook.save('snapshot-id', {
  folder_name: 'Inbox',
  output_path: 'backup.zip',
});

// save all snapshots for a mailbox as EML zip archive
const fullSave = await atlas.outlook.saveMailbox('user@company.com', {
  output_path: 'full-backup.zip',
  skip_integrity_check: true,
});

// list backed-up mailboxes
const mailboxes = await atlas.outlook.listMailboxes();

// list snapshots for a mailbox
const snapshots = await atlas.outlook.listSnapshots('user@company.com');

// get full manifest for a snapshot
const detail = await atlas.outlook.getSnapshotDetail('snapshot-id');

// read a single message
const message = await atlas.outlook.readMessage('snapshot-id', 'msg-42');

// delete all data for a mailbox
const deletion = await atlas.outlook.deleteMailboxData('user@company.com');

// delete a single snapshot
await atlas.outlook.deleteSnapshot('snapshot-id');

// get storage stats for a mailbox
const stats = await atlas.outlook.getMailboxStats('user@company.com');

// check if a mailbox backup is current (fast delta peek)
const status = await atlas.outlook.checkMailboxStatus('user@company.com');
console.log(status.is_up_to_date, status.total_pending_changes);
```

## OneDrive Methods

OneDrive operations are scoped under `atlas.onedrive`. Methods take an `ownerId` -- the Entra object ID of the user whose drive is being backed up, verified, or restored.

```typescript
// incremental backup (delta sync)
const result = await atlas.onedrive.backup('owner-id');

// force full crawl
const full = await atlas.onedrive.backup('owner-id', { force_full: true });

// verify snapshot integrity (blob checksums + index consistency)
const verify = await atlas.onedrive.verify('owner-id', 'snapshot-id');
console.log(`Checked: ${verify.total_checked}, Passed: ${verify.passed}`);

// restore files from a snapshot (long-running)
const restore = await atlas.onedrive.restore('owner-id', {
  snapshot_id: 'snapshot-id',
  conflict_behavior: 'rename',
});

// save files from a snapshot to a local zip archive
const saved = await atlas.onedrive.save('owner-id', {
  snapshot_id: 'od-snap-123',
  output_path: 'onedrive-backup.zip',
});
console.log(`Saved: ${saved.files_saved} files (${saved.total_bytes} bytes)`);

// save specific files only
const partial = await atlas.onedrive.save('owner-id', {
  snapshot_id: 'od-snap-123',
  file_filter: ['/Documents/report.docx'],
  skip_integrity_check: true,
});

// list snapshots for a user
const snapshots = await atlas.onedrive.listSnapshots('owner-id');

// list version history for a file
const versions = await atlas.onedrive.listFileVersions('owner-id', 'file-ref');
```

`backup` accepts optional `OneDriveBackupOptions`:

| Option               | Type      | Description                          |
| -------------------- | --------- | ------------------------------------ |
| `force_full`         | `boolean` | Ignore saved delta links, full crawl |
| `owner_email`        | `string`  | Display email for the owner          |
| `owner_display_name` | `string`  | Human-readable owner name            |

## SharePoint Methods

SharePoint operations are scoped under `atlas.sharepoint`. Methods take a `siteId` -- the Graph API site identifier or a site URL resolved by the connector.

```typescript
// incremental backup (delta sync)
const result = await atlas.sharepoint.backup('site-id');

// force full crawl
const full = await atlas.sharepoint.backup('site-id', { force_full: true });

// verify snapshot integrity (blob checksums + index consistency)
const verify = await atlas.sharepoint.verify('site-id', 'snapshot-id');
console.log(`Checked: ${verify.total_checked}, Passed: ${verify.passed}`);
if (verify.failed_file_ids.length > 0) {
  console.error('Corrupt files:', verify.failed_file_ids);
}

// restore files from a snapshot back to the site
const restored = await atlas.sharepoint.restore('site-id', { snapshot_id: 'sp-snap-123' });
console.log(`Restored: ${restored.files_restored} files, ${restored.folders_created} folders`);

// restore to a different site with file filter
await atlas.sharepoint.restore('site-id', {
  snapshot_id: 'sp-snap-123',
  target_site_id: 'other-site-id',
  file_filter: ['/Documents/report.docx'],
  conflict_behavior: 'replace',
});

// save files from a snapshot to a local zip archive
const saved = await atlas.sharepoint.save('site-id', {
  snapshot_id: 'sp-snap-123',
  output_path: 'sharepoint-backup.zip',
});
console.log(`Saved: ${saved.files_saved} files (${saved.total_bytes} bytes)`);

// replicate to secondary storage
const replication = await atlas.sharepoint.replicateAll('site-id', [offsite]);
const single = await atlas.sharepoint.replicateSnapshot('site-id', 'snapshot-id', [offsite]);

// disaster recovery from replica
await atlas.sharepoint.rehydrateSite('site-id', offsite);
await atlas.sharepoint.rehydrateSnapshot('site-id', 'snapshot-id', offsite);
```

`backup` accepts optional `SharePointBackupOptions`:

| Option             | Type      | Description                              |
| ------------------ | --------- | ---------------------------------------- |
| `force_full`       | `boolean` | Ignore saved delta links, full crawl     |
| `site_url`         | `string`  | Display URL for the site                 |
| `site_display_name`| `string`  | Human-readable site name                 |

`restore` accepts `SharePointRestoreOptions`:

| Option | Type | Description |
| --- | --- | --- |
| `snapshot_id` | `string` | Snapshot to restore from (required) |
| `target_site_id` | `string` | Restore to a different site (defaults to original) |
| `file_filter` | `string[]` | Only restore specific files (by ID or path) |
| `conflict_behavior` | `'replace' \| 'rename' \| 'fail'` | File conflict policy (default: `rename`) |

Replication and rehydration methods mirror `atlas replicate` / `atlas rehydrate` for SharePoint sites.

| Method | Description |
| ------ | ----------- |
| `restore(siteId, options)` | Restore files from a snapshot to the site's document libraries |
| `save(siteId, options)` | Decrypt and save files from a snapshot to a local zip archive |
| `replicateSnapshot(siteId, snapshotId, targets)` | Replicate one sealed SharePoint snapshot |
| `replicateAll(siteId, targets)` | Replicate all unreplicated snapshots for a site |
| `rehydrateSnapshot(siteId, snapshotId, source)` | Recover one snapshot from a replica |
| `rehydrateSite(siteId, source)` | Recover all site snapshots from a replica |

`verify` returns a `SharePointVerificationResult`:

```typescript
interface SharePointVerificationResult {
  snapshot_id: string;
  total_checked: number;
  passed: number;
  failed_file_ids: string[];
  index_issues: string[];
}
```

## Cross-cutting Methods

Storage checks, bucket statistics, and replication/rehydration live at the root of the instance (not under a workload namespace).

```typescript
// check storage readiness
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retention_days: 30 });

// get tenant-wide bucket statistics
const bucketStats = await atlas.getBucketStats();

// replicate a snapshot to secondary targets
const results = await atlas.replicateSnapshot('snapshot-id', [offsite]);

// replicate all unreplicated snapshots for a mailbox
const mailboxResults = await atlas.replicateMailbox('user@company.com', [offsite]);

// query replication status
const status = await atlas.getReplicationStatus('snapshot-id');
const mailboxStatus = await atlas.getReplicationStatusByMailbox('user@company.com');

// disaster recovery: recover from a replica
await atlas.rehydrateSnapshot('snapshot-id', offsite);
await atlas.rehydrateMailbox('user@company.com', offsite);
await atlas.rehydrateTenant(offsite);
```

See [Replication](#replication) below for `createStorageTarget` setup and full replication workflow details.

## Save Options

### Outlook Save Options

The `atlas.outlook.save` and `atlas.outlook.saveMailbox` methods accept the following options:

| Option                 | Type      | Description                                               |
| ---------------------- | --------- | --------------------------------------------------------- |
| `folder_name`          | `string`  | Save only messages from this folder                       |
| `message_ref`          | `string`  | Save a single message by index or ID                      |
| `start_date`           | `Date`    | Include snapshots on or after this date                   |
| `end_date`             | `Date`    | Include snapshots on or before this date                  |
| `output_path`          | `string`  | Output zip file path (default: `Restore-<timestamp>.zip`) |
| `skip_integrity_check` | `boolean` | Skip SHA-256 verification (default: `false`)              |

Both methods return a `SaveResult`:

```typescript
interface SaveResult {
  snapshot_id: string;
  saved_count: number;
  attachment_count: number;
  error_count: number;
  errors: string[];
  output_path: string;
  total_bytes: number;
  integrity_failures: string[];
}
```

### OneDrive / SharePoint Save Options

The `atlas.onedrive.save` and `atlas.sharepoint.save` methods accept `FileSaveOptions`:

| Option                 | Type       | Description                                                   |
| ---------------------- | ---------- | ------------------------------------------------------------- |
| `snapshot_id`          | `string`   | Snapshot to save from (required)                              |
| `file_filter`          | `string[]` | Only save specific files (by ID or full path)                 |
| `output_path`          | `string`   | Output zip file path (default: auto-generated)                |
| `skip_integrity_check` | `boolean`  | Skip SHA-256 verification (default: `false`)                  |

Both methods return a `FileSaveResult`:

```typescript
interface FileSaveResult {
  snapshot_id: string;
  files_saved: number;
  files_skipped: number;
  errors: string[];
  integrity_failures: string[];
  output_path: string;
  total_bytes: number;
}
```

## Batch Processing

For backing up multiple mailboxes, the recommended approach is the CLI's built-in tenant-wide mode (`atlas outlook backup` without `-m`), which handles parallel workers with rate limiting and a live dashboard.

For SDK usage, create one instance and iterate sequentially. Each backup/restore/save operation makes hundreds or thousands of Microsoft Graph API requests internally, so running mailboxes in parallel with `Promise.all` would overwhelm the Graph API and trigger aggressive throttling (HTTP 429 responses). Atlas retries throttled requests with exponential backoff up to 12 times, but parallel mailbox processing multiplies the request rate and makes throttling almost guaranteed. Sequential loops ensure reliable throughput:

```typescript
const mailboxIds = ['alice@company.com', 'bob@company.com', 'carol@company.com'];

for (const mailboxId of mailboxIds) {
  const result = await atlas.outlook.backup(mailboxId);
  console.log(`${mailboxId}: snapshot ${result.snapshot.id}`);
}
```

## Replication

The SDK supports snapshot-level replication and disaster recovery rehydration. A `StorageTarget` represents a secondary S3 endpoint -- it only needs S3 credentials and the shared passphrase (no M365 credentials).

```typescript
import { createAtlasInstance, createStorageTarget } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({ /* primary config */ });

const offsite = createStorageTarget({
  targetId: 'offsite-dr',
  s3Endpoint: 'http://offsite:9000',
  s3AccessKey: 'offsite-key',
  s3SecretKey: 'offsite-secret',
  encryptionPassphrase: 'same-passphrase-as-primary',
});

// Replicate a snapshot to one or more targets
const results = await atlas.replicateSnapshot('snapshot-id', [offsite]);

// Replicate all unreplicated snapshots for a mailbox
const mailboxResults = await atlas.replicateMailbox('user@company.com', [offsite]);

// Query replication status
const status = await atlas.getReplicationStatus('snapshot-id');

// Disaster recovery: recover from a replica
await atlas.rehydrateSnapshot('snapshot-id', offsite);
await atlas.rehydrateMailbox('user@company.com', offsite);
await atlas.rehydrateTenant(offsite);
```

`createStorageTarget` accepts a `StorageTargetConfig`:

| Option                 | Type     | Description                                                    |
| ---------------------- | -------- | -------------------------------------------------------------- |
| `targetId`             | `string` | Stable human-readable ID (auto-derived from endpoint if omitted) |
| `s3Endpoint`           | `string` | S3 endpoint URL                                                |
| `s3AccessKey`          | `string` | S3 access key                                                  |
| `s3SecretKey`          | `string` | S3 secret key                                                  |
| `s3Region`             | `string` | S3 region (default: `us-east-1`)                               |
| `encryptionPassphrase` | `string` | Must match the primary passphrase (shared encryption model)    |

## Exports

The SDK exports its own types via `m365-atlas/sdk`. Domain types, port interfaces, and result types are available from the root `m365-atlas` import for advanced use cases.

From `m365-atlas/sdk`:

- Instance types: `AtlasInstance`, `AtlasInstanceConfig`
- Sub-API types: `OutlookApi`, `OneDriveApi`, `SharePointApi`
- Stats types: `BucketStats`, `MailboxStats`, `FolderStats`, `MonthlyBreakdown`
- Status types: `MailboxStatusResult`, `FolderStatus`
- Replication types: `ReplicationResult`, `ReplicationStatusRecord`, `StorageTarget`, `StorageTargetConfig`
- Factory functions: `createAtlasInstance`, `createStorageTarget`
