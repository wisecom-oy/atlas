# Programmatic SDK

Atlas ships as two npm packages:

| Package | Install | Use when |
| ------- | ------- | -------- |
| **`@atlas/cli`** | `npm install -g @atlas/cli` | Day-to-day operations from a shell: cron jobs, one-off backups, operator workflows. Reads `.env` and config files. |
| **`@atlas/sdk`** | `npm add @atlas/sdk` | Embedding Atlas in your own Node.js app: multi-tenant SaaS, custom schedulers, portals, or automation that needs typed programmatic control. |

This page documents **`@atlas/sdk`**. For shell commands and flags, see [CLI Commands](/reference/cli).

The SDK is a standalone package with all internal modules bundled in — a single install, no peer `@atlas/*` packages to add. The API is organized by workload namespace (`atlas.outlook`, `atlas.onedrive`, `atlas.sharepoint`) plus cross-cutting methods on the root instance (`replicateSnapshot`, `getBucketStats`, etc.).

## Installation

```bash
npm add @atlas/sdk
```

## Creating an Instance

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
```

All config is explicit -- the SDK **does not read environment variables or config files**. This is a deliberate security choice for multi-tenant environments: there is no risk of accidentally picking up credentials from a stale `.env` file or inheriting environment variables meant for a different tenant. Every value is passed explicitly at construction time.

The tenant is bound at creation time, so every method operates within that tenant scope.

The SDK uses standard ES6 camelCase naming. All methods are async and return Promises.

## Available Methods

`createAtlasInstance` returns an `AtlasInstance` with three workload sub-APIs and cross-cutting tenant methods:

```typescript
// --- Outlook (mailboxes) ---
const result = await atlas.outlook.backup('user@company.com', { force_full: true });
const mailboxes = await atlas.outlook.listMailboxes();
const snapshots = await atlas.outlook.listSnapshots('user@company.com');
const verification = await atlas.outlook.verify('snapshot-id');
const restore = await atlas.outlook.restore('snapshot-id', { folder_name: 'Inbox' });
const fullRestore = await atlas.outlook.restoreMailbox('user@company.com');
const save = await atlas.outlook.save('snapshot-id', { folder_name: 'Inbox', output_path: 'backup.zip' });
const message = await atlas.outlook.readMessage('snapshot-id', '42');
const status = await atlas.outlook.checkMailboxStatus('user@company.com');

// --- OneDrive ---
const od = await atlas.onedrive.backup('owner-id');
await atlas.onedrive.verify('owner-id', 'od-snap-123');
await atlas.onedrive.checkStatus('owner-id');

// --- SharePoint ---
const sp = await atlas.sharepoint.backup('site-id');
await atlas.sharepoint.verify('site-id', 'sp-snap-123');
const sites = await atlas.sharepoint.listSites();

// --- Cross-cutting (tenant scope) ---
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retention_days: 30 });
const stats = await atlas.getBucketStats();
await atlas.replicateSnapshot('snapshot-id', [offsite]);
```

Method names mirror the CLI structure: `atlas outlook backup` maps to `atlas.outlook.backup()`, `atlas onedrive backup` to `atlas.onedrive.backup()`, and so on. See [SDK Examples](/reference/examples) for production-ready patterns.

## Outlook API Reference

| Method | CLI equivalent | Description |
| ------ | -------------- | ----------- |
| `backup(mailboxId, options?)` | `atlas outlook backup -m` | Backup a single mailbox |
| `verify(snapshotId)` | `atlas outlook verify` | Verify snapshot integrity |
| `restore(snapshotId, options?)` | `atlas outlook restore -s` | Restore from a snapshot |
| `restoreMailbox(mailboxId, options?)` | `atlas outlook restore -m` | Restore all snapshots for a mailbox |
| `save(snapshotId, options?)` | `atlas outlook save -s` | Export snapshot as EML zip |
| `saveMailbox(mailboxId, options?)` | `atlas outlook save -m` | Export all snapshots as EML zip |
| `listMailboxes()` | `atlas outlook list` | List backed-up mailboxes |
| `listSnapshots(mailboxId)` | `atlas outlook list -m` | List snapshots for a mailbox |
| `readMessage(snapshotId, messageRef)` | `atlas outlook read` | Read a single message |
| `checkMailboxStatus(mailboxId)` | `atlas outlook status` | Fast delta peek (pending changes) |
| `listAvailableMailboxes(options?)` | _(discovery)_ | List all tenant mailboxes via Graph |
| `deleteMailboxData(mailboxId)` | `atlas outlook delete -m` | Delete all data for a mailbox |
| `deleteSnapshot(snapshotId)` | `atlas outlook delete -s` | Delete a single snapshot manifest |
| `purgeTenantData()` | `atlas outlook delete --purge` | Purge entire tenant bucket |
| `getMailboxStats(mailboxId)` | `atlas stats -m` | Mailbox-level statistics |

OneDrive and SharePoint expose parallel methods on `atlas.onedrive` and `atlas.sharepoint` (including workload-specific replication). See [OneDrive Backup](/onedrive-backup) and [SharePoint Backup](/sharepoint-backup) for full SDK examples per workload.

## Save Options

`atlas.outlook.save` and `atlas.outlook.saveMailbox` accept the following options:

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

`atlas.outlook.restore` and `atlas.outlook.restoreMailbox` accept the following options:

| Option           | Type     | Description                              |
| ---------------- | -------- | ---------------------------------------- |
| `folder_name`    | `string` | Restore only messages from this folder   |
| `message_ref`    | `string` | Restore a single message by index or ID  |
| `target_mailbox` | `string` | Target mailbox for cross-mailbox restore |
| `start_date`     | `Date`   | Include snapshots on or after this date  |
| `end_date`       | `Date`   | Include snapshots on or before this date |

Both methods return a `RestoreResult`:

```typescript
interface RestoreResult {
  snapshot_id: string;
  restored_count: number;
  attachment_count: number;
  error_count: number;
  attachment_error_count: number;
  errors: string[];
  verification_warnings: string[];
  restore_folder_name: string;
  graph_cost?: OperationCost; // SDK only
}
```

| Field                    | Description                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `error_count`            | Message-level failures. Matches `errors.length`.                                            |
| `attachment_error_count` | Attachment-level failures (count only; details are logged during restore).                  |
| `errors`                 | Human-readable detail for each message-level failure.                                       |
| `verification_warnings`  | Per-folder verification warnings, including API failures that prevented count confirmation. |

## Batch Processing

For backing up multiple mailboxes from a shell, use the CLI's built-in tenant-wide mode (`atlas outlook backup` without `-m`), which handles parallel workers with rate limiting and a live dashboard.

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
import { createAtlasInstance, createStorageTarget } from '@atlas/sdk';

const atlas = createAtlasInstance({
  /* primary config */
});

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

| Option                 | Type     | Description                                                      |
| ---------------------- | -------- | ---------------------------------------------------------------- |
| `targetId`             | `string` | Stable human-readable ID (auto-derived from endpoint if omitted) |
| `s3Endpoint`           | `string` | S3 endpoint URL                                                  |
| `s3AccessKey`          | `string` | S3 access key                                                    |
| `s3SecretKey`          | `string` | S3 secret key                                                    |
| `s3Region`             | `string` | S3 region (default: `us-east-1`)                                 |
| `encryptionPassphrase` | `string` | Must match the primary passphrase (shared encryption model)      |

## Graph API Cost Tracking

Every SDK method that interacts with Microsoft Graph reports how many API requests it made, broken down by service pool. The cost is returned as a `graph_cost` field on the result:

```typescript
const result = await atlas.outlook.backup('user@company.com');

console.log(result.graph_cost);
// {
//   requests_total: 852,
//   by_service: {
//     outlook: { requests: 847, resource_units: 847, upload_bytes: 0 },
//     identity: { requests: 5, resource_units: 5, upload_bytes: 0 },
//   },
//   requests_by_type: {
//     delta_sync: 312, fetch_attachments: 530,
//     list_folders: 5, mailbox_exists: 2, list_users: 3,
//   },
//   elapsed_ms: 45200,
// }
```

Methods that report `graph_cost`: `atlas.outlook.backup`, `atlas.outlook.restore`, `atlas.outlook.restoreMailbox`, `atlas.outlook.checkMailboxStatus`.

### OperationCost Type

```typescript
interface OperationCost {
  requests_total: number;
  by_service: Partial<Record<GraphServicePool, ServicePoolCost>>;
  requests_by_type: Record<string, number>;
  elapsed_ms: number;
}

interface ServicePoolCost {
  requests: number; // API calls made against this pool
  resource_units: number; // RU consumed (equals requests for flat-cost Outlook pool)
  upload_bytes: number; // Request body bytes (relevant for Outlook 150 MB/5min limit)
}

type GraphServicePool = 'outlook' | 'sharepoint_onedrive' | 'identity';
```

Only pools that were actually used during the operation appear as keys in `by_service`. A mail backup typically has `outlook` and `identity` entries.

### GRAPH_SERVICE_LIMITS

The officially-sourced throttling limits are exported as a frozen constant so your scheduler can use the same numbers Atlas uses internally:

```typescript
import { GRAPH_SERVICE_LIMITS } from '@atlas/sdk';

const outlook = GRAPH_SERVICE_LIMITS.outlook;
// outlook.requests_per_window      => 10,000
// outlook.window_duration_ms       => 600,000 (10 min)
// outlook.max_concurrent_requests  => 4

const sp = GRAPH_SERVICE_LIMITS.sharepoint_onedrive;
// sp.resource_units_per_minute['0-1000'] => 1,250
// sp.delta_with_token_cost               => 1

const identity = GRAPH_SERVICE_LIMITS.identity;
// identity.resource_units_per_10s['L']   => 8,000
// identity.users_list_cost               => 2
```

See the [Graph API Rate Limits](/operations/graph-rate-limits) page for the full reference including all pool limits, cost models, and official Microsoft documentation links.

### Scheduling with pg-boss

A common pattern for SaaS products is to queue one job per mailbox using pg-boss and use `graph_cost` to compute a cooldown before scheduling the next job:

```typescript
import { createAtlasInstance, GRAPH_SERVICE_LIMITS } from '@atlas/sdk';
import type { OperationCost } from '@atlas/sdk';
import PgBoss from 'pg-boss';

const boss = new PgBoss(DATABASE_URL);

boss.work('backup-mailbox', async (job) => {
  const { tenant_config, mailbox_id } = job.data;
  const atlas = createAtlasInstance(tenant_config);

  const result = await atlas.outlook.backup(mailbox_id);
  const cost: OperationCost = result.graph_cost;

  // Store per-pool costs for trend analysis
  await db.query(
    `INSERT INTO backup_costs
       (mailbox_id, outlook_requests, identity_requests, elapsed_ms, completed_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [
      mailbox_id,
      cost.by_service.outlook?.requests ?? 0,
      cost.by_service.identity?.requests ?? 0,
      cost.elapsed_ms,
    ],
  );

  // Compute cooldown from the Outlook pool limit (bottleneck for mail backup)
  const outlook_limits = GRAPH_SERVICE_LIMITS.outlook;
  const outlook_used = cost.by_service.outlook?.requests ?? 0;
  const usage_ratio = outlook_used / outlook_limits.requests_per_window;
  const cooldown_ms = Math.ceil(usage_ratio * outlook_limits.window_duration_ms);

  // Re-enqueue after cooldown
  await boss.send('backup-mailbox', job.data, {
    startAfter: new Date(Date.now() + cooldown_ms),
  });
});
```

Because the Outlook pool limit is per-mailbox, each mailbox's cooldown is independent. Running 50 parallel pg-boss workers for 50 different mailboxes is safe -- they do not share quota.

For future OneDrive backup jobs, the `sharepoint_onedrive` pool is per-tenant. You would need to aggregate `resource_units` across all users of a tenant and compare against `GRAPH_SERVICE_LIMITS.sharepoint_onedrive.resource_units_per_minute['<tier>']` before scheduling the next OneDrive job.

## Exports

`@atlas/sdk` re-exports all domain types, port interfaces, and result types, so everything below is available from a single `@atlas/sdk` import.

- Instance types: `AtlasInstance`, `AtlasInstanceConfig`
- Sub-API types: `OutlookApi`, `OneDriveApi`, `SharePointApi`
- Stats types: `BucketStats`, `MailboxStats`, `FolderStats`, `MonthlyBreakdown`
- Status types: `MailboxStatusResult`, `FolderStatus`, `OneDriveStatusResult`, `OneDriveDriveStatus`, `SharePointStatusResult`, `SharePointLibraryStatus`
- Identity types: `ResolvedUserIdentity`, `IdentityRegistry`, `IdentityRegistryEntry`
- Discovery types: `TenantMailbox`, `MailboxDiscoveryOptions`
- Deletion types: `DeletionResult`
- Replication types: `ReplicationResult`, `ReplicationStatusRecord`, `StorageTarget`, `StorageTargetConfig`
- Factory functions: `createAtlasInstance`, `createStorageTarget`

**Graph cost types:**

| Export                    | Kind  | Description                                                            |
| ------------------------- | ----- | ---------------------------------------------------------------------- |
| `OperationCost`           | type  | Per-operation cost breakdown                                           |
| `ServicePoolCost`         | type  | Cost for a single service pool                                         |
| `GraphServicePool`        | type  | Pool identifier union type                                             |
| `GraphServiceLimits`      | type  | Type for the full limits constant                                      |
| `OutlookServiceLimits`    | type  | Outlook pool limits type                                               |
| `SharePointServiceLimits` | type  | SharePoint/OneDrive pool limits type                                   |
| `IdentityServiceLimits`   | type  | Identity pool limits type                                              |
| `GRAPH_SERVICE_LIMITS`    | value | Frozen official limits constant                                        |
| `SyncResult`              | type  | Result of `atlas.outlook.backup` (includes `graph_cost`)                      |
| `RestoreResult`           | type  | Result of `atlas.outlook.restore` / `restoreMailbox` (includes `graph_cost`) |
