# Programmatic SDK

Atlas ships as two npm packages:

| Package                  | Install                             | Use when                                                                                                                                     |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@wisecom/atlas-cli`** | `npm install -g @wisecom/atlas-cli` | Day-to-day operations from a shell: cron jobs, one-off backups, operator workflows. Reads `.env` and config files.                           |
| **`@wisecom/atlas-sdk`** | `npm add @wisecom/atlas-sdk`        | Embedding Atlas in your own Node.js app: multi-tenant SaaS, custom schedulers, portals, or automation that needs typed programmatic control. |

This page documents **`@wisecom/atlas-sdk`**. For shell commands and flags, see [CLI Commands](/reference/cli).

The SDK is a standalone package with every internal module bundled in. One install, no peer `@wisecom/atlas-*` packages to add. The API is organized by workload namespace (`atlas.outlook`, `atlas.onedrive`, `atlas.sharepoint`) plus cross-cutting methods on the root instance (`replicateSnapshot`, `getBucketStats`, etc.).

## Installation

```bash
npm add @wisecom/atlas-sdk
```

## Creating an Instance

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
```

All config is explicit. The SDK **does not read environment variables or config files**, a deliberate security choice for multi-tenant environments: no credentials picked up from a stale `.env` file, no environment variables inherited from a different tenant. Every value is passed at construction time.

The tenant is bound at creation time, so every method operates within that tenant scope. Methods use camelCase naming, are async, and return Promises.

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
const save = await atlas.outlook.save('snapshot-id', {
  folder_name: 'Inbox',
  output_path: 'backup.zip',
});
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

## Progress and Cancellation

Every Outlook, OneDrive, and SharePoint `backup`, `restore`, `save`, and `verify` method accepts two common options:

```typescript
const controller = new AbortController();

const result = await atlas.outlook.backup('user@company.com', {
  signal: controller.signal,
  onProgress(event) {
    console.log(event.phase, event.processed, event.total, event.current);
    if (event.processed >= 1000) controller.abort();
  },
});

if (result.interrupted) {
  console.log('Stopped safely; rerun to continue from the last committed delta');
}
```

| Option       | Type                                      | Description                                                                                     |
| ------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `onProgress` | `(event: OperationProgressEvent) => void` | Receives discovery, per-item processing, finalization, and terminal progress events.            |
| `signal`     | `AbortSignal`                             | Requests graceful cancellation. Atlas finishes the current item, then stops at a safe boundary. |

`OperationProgressEvent` is stable across workloads:

```typescript
interface OperationProgressEvent {
  operation: 'backup' | 'restore' | 'save' | 'verify';
  workload: 'outlook' | 'onedrive' | 'sharepoint';
  phase: 'discovering' | 'processing' | 'finalizing' | 'completed' | 'interrupted';
  processed: number;
  total?: number;
  current?: string;
  rate?: number;
}
```

Cancellation returns normally with `interrupted: true`; it does not throw an abort error. Restore and save results contain partial counts, and save finalizes a valid zip with the completed files. A partially processed backup does not advance that folder, drive, or library's delta cursor, so the next run safely replays it. Completed units remain committed.

The callback is optional and runs inline with the operation. Keep it fast; move network writes or database updates to your own queue.

## Outlook API Reference

| Method                                | CLI equivalent                 | Description                                                                                        |
| ------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `backup(mailboxId, options?)`         | `atlas outlook backup -m`      | Backup a single mailbox                                                                            |
| `verify(snapshotId, options?)`        | `atlas outlook verify`         | Verify full restorable state (chain-aware, incl. attachments); `{ fast: true }` for existence-only |
| `restore(snapshotId, options?)`       | `atlas outlook restore -s`     | Restore from a snapshot                                                                            |
| `restoreMailbox(mailboxId, options?)` | `atlas outlook restore -m`     | Restore all snapshots for a mailbox                                                                |
| `save(snapshotId, options?)`          | `atlas outlook save -s`        | Export snapshot as EML zip                                                                         |
| `saveMailbox(mailboxId, options?)`    | `atlas outlook save -m`        | Export all snapshots as EML zip                                                                    |
| `listMailboxes()`                     | `atlas outlook list`           | List backed-up mailboxes                                                                           |
| `listSnapshots(mailboxId)`            | `atlas outlook list -m`        | List snapshots for a mailbox                                                                       |
| `readMessage(snapshotId, messageRef)` | `atlas outlook read`           | Read a single message                                                                              |
| `checkMailboxStatus(mailboxId)`       | `atlas outlook status`         | Fast delta peek (pending changes)                                                                  |
| `listAvailableMailboxes(options?)`    | _(discovery)_                  | List all tenant mailboxes via Graph                                                                |
| `deleteMailboxData(mailboxId)`        | `atlas outlook delete -m`      | Delete all data for a mailbox                                                                      |
| `deleteSnapshot(snapshotId)`          | `atlas outlook delete -s`      | Delete a single snapshot manifest                                                                  |
| `purgeTenantData()`                   | `atlas outlook delete --purge` | Purge entire tenant bucket                                                                         |
| `getMailboxStats(mailboxId)`          | `atlas stats -m`               | Mailbox-level statistics                                                                           |

OneDrive and SharePoint expose parallel methods on `atlas.onedrive` and `atlas.sharepoint` (including workload-specific replication). See [OneDrive Backup](/onedrive-backup) and [SharePoint Backup](/sharepoint-backup) for full SDK examples per workload.

Deletion methods erase every version of the objects they match. `purgeTenantData()` sweeps the whole bucket, every workload and not only Outlook. The returned `DeletionResult` separates `retained_*` (blocked by Object Lock, deletable once retention expires) from `failed_*` (everything else, which will not clear on its own). See [Erasure](/security#erasure).

### Shared mailbox identity

Three result types carry an optional `mailbox_purpose` field (`'user' | 'linked' | 'shared' | 'room' | 'equipment' | 'others'`), sourced from the Graph `mailboxSettings.userPurpose` property. A value of `'shared'` identifies a shared mailbox:

- `TenantMailbox.mailbox_purpose` (from `listAvailableMailboxes()`; resolved only for unlicensed mailboxes during discovery)
- `MailboxSummary.mailbox_purpose` (from `listMailboxes()`; taken from the newest manifest that recorded one, so a transient lookup failure in the latest backup does not blank the field)
- `Manifest.mailbox_purpose` (from `backup()`, `listSnapshots()`, `getSnapshotDetail()`; recorded at backup time)

The field is absent when the purpose was never resolved (pre-feature manifests, lookup failures):

```typescript
const mailboxes = await atlas.outlook.listAvailableMailboxes();
const shared = mailboxes.filter((mb) => mb.mailbox_purpose === 'shared');
```

### Identifier case

Every method taking a mailbox address, an Entra object ID, or a SharePoint site ID lowercases it before it becomes a storage key segment, so two spellings of one identifier address one tree.

The SDK is where this used to bite. Graph hands back these identifiers lowercase, so the CLI never saw the problem; an embedder holding an object ID in application state or reading one from a portal could. Two spellings meant two prefixes, so the same drive was backed up twice. Worse:

```typescript
// Before 2.1.0-beta: swept an empty prefix, reported what it deleted there,
// and left the real data behind -- a successful-looking erasure of nothing.
await atlas.onedrive.deleteOwnerData('75A21B57-4D82-4F42-9CCC-7C231C30F78C');
```

Graph **item** IDs (`file_id`, `item_id`) are case-sensitive and never folded. `file_filter` compares them case-insensitively, so an ID copied from `listFileVersions()` matches whatever case you send it in.

## Save Options

`atlas.outlook.save` and `atlas.outlook.saveMailbox` accept the following options:

| Option                 | Type      | Description                                               |
| ---------------------- | --------- | --------------------------------------------------------- |
| `folder_name`          | `string`  | Save only this folder and its subfolders (name or path)   |
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
  interrupted: boolean;
}
```

## Restore Options

`atlas.outlook.restore` and `atlas.outlook.restoreMailbox` accept the following options:

| Option           | Type     | Description                                                |
| ---------------- | -------- | ---------------------------------------------------------- |
| `folder_name`    | `string` | Restore only this folder and its subfolders (name or path) |
| `message_ref`    | `string` | Restore a single message by index or ID                    |
| `target_mailbox` | `string` | Target mailbox for cross-mailbox restore                   |
| `start_date`     | `Date`   | Include snapshots on or after this date                    |
| `end_date`       | `Date`   | Include snapshots on or before this date                   |

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
  interrupted: boolean;
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

In the SDK, create one instance and iterate sequentially. Each backup, restore, or save makes hundreds or thousands of Graph requests internally, so running mailboxes through `Promise.all` multiplies the request rate and triggers aggressive throttling (HTTP 429). Atlas retries throttled requests with exponential backoff up to 12 times, but a sequential loop finishes sooner and more predictably:

```typescript
const mailboxIds = ['alice@company.com', 'bob@company.com', 'carol@company.com'];

for (const mailboxId of mailboxIds) {
  const result = await atlas.outlook.backup(mailboxId);
  console.log(`${mailboxId}: snapshot ${result.snapshot.id}`);
}
```

## Replication

The SDK supports snapshot-level replication and disaster recovery rehydration. A `StorageTarget` represents a secondary S3 endpoint and needs only S3 credentials plus the shared passphrase, no M365 credentials.

```typescript
import { createAtlasInstance, createStorageTarget } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({/* primary config */});

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

// Full tenant DR: every workload, reported per workload
const recovery = await atlas.rehydrateTenant(offsite);
for (const { workload, result } of recovery.workloads) {
  console.log(workload, result.objects_copied, result.objects_failed);
}
console.log(recovery.total.status);
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

### What counts as a request

One request sent through the Graph client is one recorded request. Counting
happens in the transport, immediately before the request goes out, so the number
matches what the tenant is actually charged:

- **Every page.** A delta sync that follows `@odata.nextLink` across 40 pages
  counts 40, not 1. Same for folder trees, drive listings and version history.
- **Every attempt.** A call throttled twice and succeeding on the third attempt
  counts 3. Retries made by Atlas and retries made internally by the Graph SDK
  are both visible here, and a throttled tenant is exactly when the count
  matters most.
- **Every redirect** followed to a new location.
- **Upload bytes per attempt.** A resumable chunk re-sent after a failure is
  charged twice against the Outlook 150 MB / 5-minute window, because it was.

Pre-authenticated transfers are deliberately excluded: file downloads from
`@microsoft.graph.downloadUrl` and OneDrive/SharePoint resumable chunk uploads
go straight to storage rather than through Graph, and consume no Graph quota.

`requests_by_type` labels each request with the connector operation that issued
it, so a paginated `delta_sync` shows the page count under one label.

::: warning Recorded costs are higher than in 2.1.0-beta and earlier
Earlier releases recorded one request per connector method call, so pagination
and retries were invisible and reported cost was a floor. Cooldowns derived from
it were correspondingly too short. Numbers from this release are larger for the
same work. That is the undercount being removed, not a change in what Atlas
does. Expect a step change in any dashboard built on the old values.
:::

### Cost when an operation fails

Failures are the most expensive runs a tenant pays for: a delta sync that dies on
page 400, or a request that spent its whole retry budget against a 429, has burned
more quota than any successful run in the job. That cost is attached to the thrown
error and read with `getGraphCost`:

```typescript
import { createAtlasInstance, getGraphCost } from '@wisecom/atlas-sdk';

try {
  const result = await atlas.outlook.backup('user@company.com');
  record_cost(result.graph_cost);
} catch (err) {
  // Requests already burned before the failure -- undefined if the error came
  // from somewhere other than a tracked SDK operation.
  const cost = getGraphCost(err);
  if (cost) record_cost(cost);
  throw err;
}
```

The error itself is rethrown unchanged, so `instanceof` checks and existing catch
filters keep working, and the cost is a non-enumerable property, so error logging
and serialisation are unaffected. A failure that happened before any Graph call
reports `requests_total: 0`, which is a fact worth recording rather than a missing value.

::: warning Ignoring this skews your scheduling in the wrong direction
A scheduler that reads cost only on the success path treats the most expensive
runs as free, and re-queues the next mailbox into a tenant that is already
throttled, producing another 429 and raising the throttle fence again.
:::

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
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-sdk';

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
import { createAtlasInstance, getGraphCost, GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-sdk';
import type { OperationCost } from '@wisecom/atlas-sdk';
import PgBoss from 'pg-boss';

const boss = new PgBoss(DATABASE_URL);

boss.work('backup-mailbox', async (job) => {
  const { tenant_config, mailbox_id } = job.data;
  const atlas = createAtlasInstance(tenant_config);

  let cost: OperationCost | undefined;
  try {
    const result = await atlas.outlook.backup(mailbox_id);
    cost = result.graph_cost;
  } catch (err) {
    // A failed run has usually burned MORE quota than a successful one. Bill it
    // and cool down on it, then let pg-boss see the failure.
    cost = getGraphCost(err);
    throw err;
  } finally {
    if (cost) {
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

      // Re-enqueue after cooldown -- on the failure path this is what stops the
      // retry from landing straight back on a throttled tenant.
      await boss.send('backup-mailbox', job.data, {
        startAfter: new Date(Date.now() + cooldown_ms),
      });
    }
  }
});
```

Because the Outlook pool limit is per-mailbox, each mailbox's cooldown is independent. Running 50 parallel pg-boss workers for 50 different mailboxes is safe, because they do not share quota.

For OneDrive backup jobs, the `sharepoint_onedrive` pool is per-tenant instead. Aggregate `resource_units` across all users of a tenant and compare against `GRAPH_SERVICE_LIMITS.sharepoint_onedrive.resource_units_per_minute['<tier>']` before scheduling the next OneDrive job.

## Exports

`@wisecom/atlas-sdk` re-exports all domain types, port interfaces, and result types, so everything below is available from a single `@wisecom/atlas-sdk` import.

- Instance types: `AtlasInstance`, `AtlasInstanceConfig`
- Sub-API types: `OutlookApi`, `OneDriveApi`, `SharePointApi`
- Stats types: `BucketStats`, `MailboxStats`, `FolderStats`, `MonthlyBreakdown`
- Status types: `MailboxStatusResult`, `FolderStatus`, `OneDriveStatusResult`, `OneDriveDriveStatus`, `SharePointStatusResult`, `SharePointLibraryStatus`
- Identity types: `ResolvedUserIdentity`, `IdentityRegistry`, `IdentityRegistryEntry`
- Discovery types: `TenantMailbox`, `MailboxDiscoveryOptions`
- Deletion types: `DeletionResult`
- Replication types: `ReplicationResult`, `ReplicationStatusRecord`, `StorageTarget`, `StorageTargetConfig`
- Factory functions: `createAtlasInstance`, `createStorageTarget`
- Operation control types: `SdkOperationOptions`, `OperationProgressEvent`, `OperationProgressCallback`, `OperationProgressPhase`
- Cost helpers: `getGraphCost`

**Graph cost types:**

| Export                    | Kind  | Description                                                                  |
| ------------------------- | ----- | ---------------------------------------------------------------------------- |
| `OperationCost`           | type  | Per-operation cost breakdown                                                 |
| `ServicePoolCost`         | type  | Cost for a single service pool                                               |
| `GraphServicePool`        | type  | Pool identifier union type                                                   |
| `GraphServiceLimits`      | type  | Type for the full limits constant                                            |
| `OutlookServiceLimits`    | type  | Outlook pool limits type                                                     |
| `SharePointServiceLimits` | type  | SharePoint/OneDrive pool limits type                                         |
| `IdentityServiceLimits`   | type  | Identity pool limits type                                                    |
| `GRAPH_SERVICE_LIMITS`    | value | Frozen official limits constant                                              |
| `getGraphCost`            | value | Reads the cost burned before a failed operation threw                        |
| `SyncResult`              | type  | Result of `atlas.outlook.backup` (includes `graph_cost`)                     |
| `RestoreResult`           | type  | Result of `atlas.outlook.restore` / `restoreMailbox` (includes `graph_cost`) |
