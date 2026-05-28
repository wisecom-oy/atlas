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

```typescript
// backup a single mailbox (long-running)
const result = await atlas.backupMailbox('user@company.com', { force_full: true });

// list backed-up mailboxes
const mailboxes = await atlas.listMailboxes();

// list snapshots for a mailbox
const snapshots = await atlas.listSnapshots('user@company.com');

// verify snapshot integrity
const verification = await atlas.verifySnapshot('snapshot-id');

// restore from a specific snapshot (long-running)
const restore = await atlas.restoreSnapshot('snapshot-id', { folder_name: 'Inbox' });

// restore all snapshots for a mailbox (long-running)
const fullRestore = await atlas.restoreMailbox('user@company.com');

// save snapshot as EML zip archive
const save = await atlas.saveSnapshot('snapshot-id', {
  folder_name: 'Inbox',
  output_path: 'backup.zip',
});

// save all snapshots for a mailbox as EML zip archive
const fullSave = await atlas.saveMailbox('user@company.com', {
  output_path: 'full-backup.zip',
  skip_integrity_check: true,
});

// read a single message
const message = await atlas.readMessage('snapshot-id', 'msg-42');

// delete mailbox data
const deletion = await atlas.deleteMailboxData('user@company.com');

// check if a mailbox backup is current (fast delta peek)
const status = await atlas.checkMailboxStatus('user@company.com');
console.log(status.is_up_to_date, status.total_pending_changes);

// check storage readiness
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retention_days: 30 });
```

## Save Options

The `saveSnapshot` and `saveMailbox` methods accept the following options:

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

## Restore Options

The `restoreSnapshot` and `restoreMailbox` methods accept the following options:

| Option           | Type     | Description                                    |
| ---------------- | -------- | ---------------------------------------------- |
| `folder_name`    | `string` | Restore only messages from this folder         |
| `message_ref`    | `string` | Restore a single message by index or ID        |
| `target_mailbox` | `string` | Target mailbox for cross-mailbox restore       |
| `start_date`     | `Date`   | Include snapshots on or after this date         |
| `end_date`       | `Date`   | Include snapshots on or before this date        |

Both methods return a `RestoreResult`:

```typescript
interface RestoreResult {
  snapshot_id: string;
  restored_count: number;
  attachment_count: number;
  error_count: number;
  attachment_error_count: number;
  verification_failures: number;
  errors: string[];
  attachment_errors: string[];
  verification_warnings: string[];
  restore_folder_name: string;
}
```

| Field | Description |
|-------|-------------|
| `error_count` | Message-level failures. Matches `errors.length`. |
| `attachment_error_count` | Attachment-level failures. Matches `attachment_errors.length`. |
| `verification_failures` | Messages that may not have persisted, based on post-restore folder count verification. |
| `errors` | Human-readable detail for each message-level failure. |
| `attachment_errors` | Human-readable detail for each attachment-level failure. |
| `verification_warnings` | Per-folder verification warnings, including API failures that prevented count confirmation. |

## Batch Processing

For backing up multiple mailboxes, the recommended approach is the CLI's built-in tenant-wide mode (`atlas backup` without `-m`), which handles parallel workers with rate limiting and a live dashboard.

For SDK usage, create one instance and iterate sequentially. Each backup/restore/save operation makes hundreds or thousands of Microsoft Graph API requests internally, so running mailboxes in parallel with `Promise.all` would overwhelm the Graph API and trigger aggressive throttling (HTTP 429 responses). Atlas retries throttled requests with exponential backoff up to 12 times, but parallel mailbox processing multiplies the request rate and makes throttling almost guaranteed. Sequential loops ensure reliable throughput:

```typescript
const mailboxIds = ['alice@company.com', 'bob@company.com', 'carol@company.com'];

for (const mailboxId of mailboxIds) {
  const result = await atlas.backupMailbox(mailboxId);
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

The SDK exports its own types via `m365-atlas/sdk`. Domain types, port interfaces, and result types are available from the root `m365-atlas` import for advanced use cases. Status-related types (`MailboxStatusResult`, `FolderStatus`), replication types (`ReplicationResult`, `ReplicationStatusRecord`, `StorageTarget`, `StorageTargetConfig`), and `createStorageTarget` are also exported from `m365-atlas/sdk`.
