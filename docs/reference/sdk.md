# SDK reference

`@wisecom/atlas-sdk` embeds Atlas in a Node.js application: multi-tenant services, custom schedulers, portals, and automation that needs typed control over backup, restore, save, and replication. It bundles every internal module, so one install is enough.

For shell commands, see [CLI Commands](/reference/cli). The CLI (`@wisecom/atlas-cli`) reads `.env` and config files. The SDK reads nothing from the environment.

```bash
npm add @wisecom/atlas-sdk
```

## Quick start

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';

await using atlas = createAtlasInstance({
  tenantId: '<tenant-id>',
  clientId: '<client-id>',
  clientSecret: '<client-secret>',
  s3Endpoint: 'https://s3.example.internal',
  s3AccessKey: '<access-key>',
  s3SecretKey: '<secret-key>',
  encryptionPassphrase: '<encryption-passphrase>',
});

const result = await atlas.outlook.backup('user@example.com');
console.log(result.snapshot.id, result.summary.stored);
```

`await using` requires Node.js 20 or later. Without it, call `atlas.dispose()` in a `finally` block. See [Instance lifecycle](#instance-lifecycle).

The API is organized by workload (`atlas.outlook`, `atlas.onedrive`, `atlas.sharepoint`), with tenant-wide methods on the root instance such as `replicateSnapshot`, `getBucketStats`, and `getStorageUsage`.

## Configuration

`createAtlasInstance(config)` takes every setting explicitly. Stale files or another tenant's inherited configuration cannot select credentials, because nothing is discovered.

| Option                 | Type                                   | Required | Description                                                                                                       |
| ---------------------- | -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `tenantId`             | `string`                               | Yes      | Microsoft Entra tenant ID. The tenant is bound at creation, so every call stays in this tenant                    |
| `clientId`             | `string`                               | Yes      | Application (client) ID of the app registration                                                                   |
| `clientSecret`         | `string`                               | Yes      | Client secret of the app registration                                                                             |
| `s3Endpoint`           | `string`                               | Yes      | Absolute HTTP or HTTPS URL. No embedded credentials, query, or fragment. Use HTTPS across untrusted networks      |
| `s3AccessKey`          | `string`                               | Yes      | S3 access key                                                                                                     |
| `s3SecretKey`          | `string`                               | Yes      | S3 secret key                                                                                                     |
| `s3Region`             | `string`                               | No       | S3 region. Default `us-east-1`                                                                                    |
| `encryptionPassphrase` | `string`                               | Yes      | Protects the tenant's data key. At least 14 UTF-8 bytes. Must match the passphrase used for existing backups      |
| `logger`               | `LogSink`                              | No       | Receives SDK log lines. The SDK is silent without it. See [Logging](#logging)                                     |
| `onStorageRequest`     | `(event: StorageRequestEvent) => void` | No       | Receives one event per S3 request. See [Storage request events](#storage-request-events)                          |

Construction is synchronous and makes no network requests. A missing or blank required field, a passphrase shorter than 14 bytes, or an invalid `s3Endpoint` throws `ConfigError` (`ATLAS_CONFIG_INVALID`).

The public surface is camelCase throughout: methods, configuration, option fields, and result fields. Two exceptions:

- Keys of maps that Atlas does not define stay verbatim: `deltaLinks` (keyed by Graph folder ID), `requestsByType` (keyed by request label), and `byService` (keyed by pool name).
- The raw Graph payload in `readMessage().message` keeps the shape Graph returned and the stored blob contains.

`ThrottledError.retry_after_ms` is the one error property in snake_case. See [Errors](#errors).

## Validation

`atlas.validate()` is optional. Call it after provisioning the tenant bucket to confirm the configuration works before the first run:

```typescript
import { AuthError, StorageError, WrongPassphraseError } from '@wisecom/atlas-sdk';

try {
  await atlas.validate();
} catch (error) {
  if (error instanceof StorageError) {
    console.error('Check the S3 endpoint, credentials, and tenant bucket access.');
  } else if (error instanceof WrongPassphraseError) {
    console.error("The passphrase does not open this tenant's existing data key.");
  } else if (error instanceof AuthError) {
    console.error('Check the Microsoft Entra credentials and connectivity.');
  }
  throw error;
}
```

`validate(): Promise<void>` runs three checks in order and stops at the first failure:

| Stage                                     | Failure                                          | Operator action                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| S3 `HeadBucket` on `atlas-{tenantId}`     | `StorageError`, `ATLAS_STORAGE_FAILURE`          | Check the endpoint, region, credentials, bucket existence, and `s3:ListBucket` access. A missing bucket fails; provision it first      |
| Unwrap of `_meta/dek.enc`, if it exists   | `WrongPassphraseError`, `ATLAS_WRONG_PASSPHRASE` | Use the passphrase that created this tenant's backups. In a multi-tenant service, confirm each tenant has its own matching passphrase |
| Microsoft Graph token                     | `AuthError`, `ATLAS_AUTH_DENIED`                 | Check the tenant ID, client ID, client secret, and connectivity to Microsoft Entra ID                                                 |

These codes name the failed stage, not always bad credentials. DNS, TLS, and transport failures also cause rejection. Each error keeps the original failure as `cause`.

The key stage makes at most one storage `GET` and opens the key locally with AES-256-GCM. It never creates a missing key, writes an object, or logs key material. A fresh tenant with no key passes this stage, and the first backup creates the key.

`validate()` does not check write permissions, Object Lock readiness, or workload-specific Graph consent. Use `checkStorage()` for Object Lock readiness. See [Security](/security#kek-derivation-scrypt) for passphrase guidance.

## Logging

The SDK is silent by default. Pass a `logger` to receive its output:

```typescript
import pino from 'pino';

const log = pino();

const atlas = createAtlasInstance({
  /* ...credentials... */
  logger: {
    debug: (message, fields) => log.debug(fields, message),
    info: (message, fields) => log.info(fields, message),
    warn: (message, fields) => log.warn(fields, message),
    error: (message, fields) => log.error(fields, message),
  },
});
```

`LogSink` has four methods: `debug`, `info`, `warn`, and `error`. Adapting `pino`, `winston`, an OpenTelemetry exporter, or `console` takes a few lines.

Each line includes `fields` that identify the source:

```json
{ "tenantId": "00000000-0000-0000-0000-000000000000", "operation": "backup" }
```

`operation` names the SDK method that produced the line, so one process serving many tenants can attribute output without matching timestamps. Progress output is not logged. Use [progress events](#progress-and-cancellation) instead.

`debug` lines reach the sink regardless of the `DEBUG` environment variable. The host's logger decides which levels to keep.

:::tip
Logs are not the record of a run. The typed result carries what happened: `summary.warnings`, `summary.folderErrors`, `summary.excludedFolders`, and `integrityFailures`. Do not parse log text to find out what a run did.
:::

## Storage request events

`onStorageRequest` receives one `StorageRequestEvent` per S3 request the instance sends. Each event includes the duration, the split between connection-pool queueing (`socketWaitMs`) and backend time (`networkMs`), SDK retries and backoff, payload size, and outcome. Events never carry object keys, bucket names, or endpoint hosts.

```typescript
const atlas = createAtlasInstance({
  /* ...credentials... */
  onStorageRequest: (event) =>
    storageLatency.record(event.networkMs ?? event.durationMs, {
      command: event.command,
      keyClass: event.keyClass,
    }),
});
```

Without the option, nothing is measured and the storage path is unchanged. The callback runs synchronously on the storage path, so it should only record. A throw or a rejected promise is ignored. A value that is not a function throws `ConfigError` at construction.

See [Storage request events](/reference/storage-request-events) for the field reference and an OpenTelemetry example.

## Instance lifecycle

An instance holds an S3 client with keep-alive socket pools and a cache of bucket state. Create one per tenant and dispose it when finished:

```typescript
const atlas = createAtlasInstance({
  /* ...config... */
});
try {
  await atlas.outlook.backup('user@example.com');
} finally {
  await atlas.dispose();
}
```

With `await using`, disposal happens at the end of the block, including when it throws:

```typescript
await using atlas = createAtlasInstance({
  /* ...config... */
});
await atlas.outlook.backup('user@example.com');
```

`dispose()` closes the socket pools, clears the bucket cache, and unbinds the container. It is idempotent and never throws: a failing step is logged and the remaining steps still run. Do not use the instance afterwards.

A service that creates an instance per request and never disposes it accumulates socket pools for the lifetime of the process.

:::warning
`dispose()` drops the instance's reference to `encryptionPassphrase`, and derived key buffers are zeroed. JavaScript strings are immutable, so the passphrase string itself stays in memory until garbage collection reclaims it. If that matters, keep the passphrase in a `Buffer` on your side and treat the process boundary as the security boundary.
:::

Bucket caches are per instance. Two instances with different endpoints and same-named buckets do not share answers about bucket existence or Object Lock support.

## Methods

`createAtlasInstance` returns an `AtlasInstance`:

```typescript
// Outlook: mailbox by email or Entra object ID
const result = await atlas.outlook.backup('user@example.com', { forceFull: true });
const mailboxes = await atlas.outlook.listMailboxes();
const snapshots = await atlas.outlook.listSnapshots('user@example.com');
const verification = await atlas.outlook.verify('snapshot-id');
const restore = await atlas.outlook.restore('snapshot-id', { folderName: 'Inbox' });
const save = await atlas.outlook.save('snapshot-id', { folderName: 'Inbox', outputPath: 'backup.zip' });
const message = await atlas.outlook.readMessage('snapshot-id', '42');
const status = await atlas.outlook.checkMailboxStatus('user@example.com');

// OneDrive: owner by email or Entra object ID
const od = await atlas.onedrive.backup('john.doe@example.com');
await atlas.onedrive.verify('john.doe@example.com', 'od-snap-123');
await atlas.onedrive.checkStatus('john.doe@example.com');
const odStats = await atlas.onedrive.getStats('john.doe@example.com'); // omit the owner for every drive

// SharePoint: site URL or composite site ID; returns one result per backed-up site
const site = 'https://contoso.sharepoint.com/sites/Example';
const [sp] = await atlas.sharepoint.backup(site);
const tree = await atlas.sharepoint.backup(site, { includeSubsites: true });
await atlas.sharepoint.verify(site, 'sp-snap-123');
const sites = await atlas.sharepoint.listSites();
const spStats = await atlas.sharepoint.getStats(site); // omit the site for every site

// Tenant scope
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retentionDays: 30 });
const bucket = await atlas.getBucketStats();
const usage = await atlas.getStorageUsage({ breakdown: 'owner' });
await atlas.replicateSnapshot('snapshot-id', [offsite]);
```

Method names mirror the CLI: `atlas outlook backup` maps to `atlas.outlook.backup()`, and `atlas onedrive backup` to `atlas.onedrive.backup()`. The SDK also exposes operations the CLI does not. See [SDK examples](/reference/examples) for production patterns.

### Outlook

| Method                                | CLI equivalent             | Description                                                                                          |
| ------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `backup(mailboxId, options?)`         | `atlas outlook backup -m`  | Back up one mailbox                                                                                  |
| `verify(snapshotId, options?)`        | `atlas outlook verify`     | Verify the restorable state, including attachments and the delta chain. `{ fast: true }` checks existence only |
| `restore(snapshotId, options?)`       | `atlas outlook restore -s` | Restore from a snapshot                                                                              |
| `restoreMailbox(mailboxId, options?)` | `atlas outlook restore -m` | Restore all snapshots for a mailbox                                                                  |
| `save(snapshotId, options?)`          | `atlas outlook save -s`    | Export a snapshot as an EML zip                                                                      |
| `saveMailbox(mailboxId, options?)`    | `atlas outlook save -m`    | Export all snapshots as an EML zip                                                                   |
| `listMailboxes()`                     | `atlas outlook list`       | List backed-up mailboxes                                                                             |
| `listSnapshots(mailboxId)`            | `atlas outlook list -m`    | List snapshots for a mailbox                                                                         |
| `getSnapshotDetail(snapshotId)`       | _(none)_                   | Read one snapshot manifest, including folders and entries                                            |
| `readMessage(snapshotId, messageRef)` | `atlas outlook read`       | Read one message                                                                                     |
| `checkMailboxStatus(mailboxId)`       | `atlas outlook status`     | Fast delta peek for pending changes. Does not advance the stored cursor                              |
| `listAvailableMailboxes(options?)`    | _(discovery)_              | List tenant mailboxes through Graph                                                                  |
| `deleteMailboxData(mailboxId)`        | `atlas outlook delete -m`  | Delete all data for a mailbox                                                                        |
| `deleteSnapshot(snapshotId)`          | `atlas outlook delete -s`  | Delete one snapshot manifest                                                                         |
| `purgeTenantData()`                   | `atlas delete --purge`     | Delete the entire tenant bucket, all workloads                                                       |
| `getMailboxStats(mailboxId)`          | `atlas stats -m`           | Mailbox-level statistics                                                                             |

### OneDrive and SharePoint

`atlas.onedrive` and `atlas.sharepoint` expose the same operations per drive owner or site: `backup`, `verify`, `restore`, `restoreVersion`, `save`, `listSnapshots`, `listFileVersions`, `replicateSnapshot`, `replicateAll`, `rehydrateSnapshot`, `checkStatus`, `getStats`, and a delete method. The delete methods are `deleteOwnerData(ownerId)` and `deleteSnapshot(ownerId, snapshotId)` on OneDrive, and `deleteSiteData(siteId)` and `deleteSnapshot(siteId, snapshotId)` on SharePoint. SharePoint also provides `listSites()`, `resolveSite(urlOrId)`, and `rehydrateSite`. OneDrive provides `rehydrateOwner`.

The snapshot lookup differs by workload. Outlook has `getSnapshotDetail(snapshotId)`. OneDrive and SharePoint do not. Find a drive snapshot with `listSnapshots(ownerId)` and filter by `snapshotId`:

```typescript
const snapshotId = 'od-snap-123';
const manifest = (await atlas.onedrive.listSnapshots('owner-id')).find(
  (snapshot) => snapshot.snapshotId === snapshotId,
);
```

See [OneDrive backup](/onedrive-backup) and [SharePoint backup](/sharepoint-backup) for workload-specific examples.

### Tenant-wide methods

| Method                                    | Description                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `validate()`                              | Checks storage, the passphrase, and Graph access. See [Validation](#validation)                   |
| `checkStorage(request?)`                  | Reports bucket reachability, versioning, Object Lock support, and the resolved retention          |
| `getBucketStats()`                        | Logical totals across the tenant: mailboxes, snapshots, messages, and sizes                      |
| `getStorageUsage(options?)`               | Bytes the bucket physically holds. See [Storage usage](#storage-usage)                            |
| `resolveUser(email)`                      | Resolves an address to an Entra object ID through Graph                                           |
| `listUsers()`                             | Returns the identity registry for this tenant, or `undefined` when none exists yet                |
| `replicateSnapshot(snapshotId, targets)`  | Copies one snapshot to each target. Returns an array of results. See [Replication](#replication) |
| `replicateMailbox(mailboxId, targets)`    | Copies every unreplicated snapshot for a mailbox                                                  |
| `rehydrateSnapshot(snapshotId, source)`   | Restores one snapshot from a replica                                                              |
| `rehydrateMailbox(mailboxId, source)`     | Restores a mailbox's snapshots from a replica                                                     |
| `rehydrateTenant(source)`                 | Restores every workload from a replica, reported per workload                                     |
| `getReplicationStatus(snapshotId?)`       | Replication status for one snapshot or all snapshots                                              |
| `getReplicationStatusByOwner(mailboxId)`  | Replication status for every snapshot of one owner                                                |
| `rewrapDataKey(newPassphrase?)`           | Re-wraps the tenant data key. See [Key re-wrap](#key-re-wrap)                                     |
| `dispose()`                               | Releases the instance. See [Instance lifecycle](#instance-lifecycle)                              |

When a drive or site backup creates no snapshot, `summary.noSnapshotReason` explains why. Its value is `'no_changes'` when content exists and nothing changed, or `'no_content'` when the drive or site holds nothing to protect. The field is set only when a completed run creates no snapshot. Branch on the reason:

```typescript
const [sp] = await atlas.sharepoint.backup(site);
if (!sp.snapshot && sp.summary.noSnapshotReason === 'no_content') {
  // Nothing to protect yet. Do not report this site as backed up.
}
```

The field is absent when a snapshot was created. Interrupted or unhealthy runs report `interrupted` and `errors` instead.

## Identifiers

Methods accept the same identifiers as the CLI and normalize them the same way.

| Namespace            | Accepted                                                                                       | Normalization                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `atlas.onedrive.*`   | Email or UPN, or Entra object ID                                                               | An argument containing `@` resolves through Graph. Anything else is used as given                               |
| `atlas.outlook.*`    | Email or UPN, or Entra object ID                                                               | An argument containing `@` resolves through Graph. Anything else is used as given                               |
| `atlas.sharepoint.*` | Site URL or hostname, or site ID (`siteGuid,webGuid`, with or without a leading host)          | An argument without commas resolves through Graph. A site ID drops its hostname without a Graph call            |

A failed resolution throws, so a mistyped address fails instead of addressing an empty scope. Resolved identities are cached per instance. Backups record the resolved email and display name as snapshot metadata, which makes owners readable in later listings. Storage keys always use the object ID. `resolveUser` and `resolveSite` are available on their own.

Object IDs and site IDs are lowercased before they become storage key segments. Two spellings of one identifier therefore address one tree. Graph item IDs (`fileId`, `itemId`) are case-sensitive and never changed. `fileFilter` compares them case-insensitively.

Outlook keys written by v5 used the SMTP address. They are not reachable under the object-ID keys. See [Migrating to v6](/migration/v6).

## Storage usage

`getStorageUsage(options?)` lists the tenant bucket and reports the bytes it physically holds. This differs from `getBucketStats()` and the workload `getStats()` methods, which report logical sizes. See [Storage usage](/operations/storage-usage) for categories, request cost, and required permissions.

```typescript
const usage = await atlas.getStorageUsage();
console.log(usage.storedBytes, usage.totals.noncurrent.bytes, usage.logicalBytesReferenced);

// A replica, measured in slices of 1,000 list requests
let part = await atlas.getStorageUsage({ target: offsite, maxListRequests: 1000 });
while (!part.complete) {
  part = await atlas.getStorageUsage({
    target: offsite,
    maxListRequests: 1000,
    continuationToken: part.continuationToken,
  });
}
```

| Option              | Type                    | Description                                                                                      |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `target`            | `StorageTarget`         | Measure this replication target instead of the primary storage                                   |
| `breakdown`         | `'workload' \| 'owner'` | `owner` adds `byOwner`, one row per mailbox, OneDrive owner, or site. Workload rows are always present |
| `maxListRequests`   | `number`                | Stop after this many S3 requests and return a continuation token                                 |
| `continuationToken` | `string`                | Resume a run that stopped early                                                                  |
| `signal`            | `AbortSignal`           | Stop at the next page boundary and return a continuation token instead of throwing               |

| Field                                         | Description                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `totals`                                      | `current`, `noncurrent`, `staging`, and `incompleteUploads` as `{ objects, bytes }`, plus `deleteMarkers` |
| `byWorkload`                                  | The same breakdown per `outlook`, `onedrive`, `sharepoint`, `meta`, and `other`. Rows sum to `totals`   |
| `byOwner`                                     | With `breakdown: 'owner'`, rows of `{ workload, ownerId, totals }`, largest first                        |
| `storedBytes`                                 | Current plus noncurrent plus incomplete upload parts                                                    |
| `logicalBytesReferenced`                      | Logical bytes that all manifests reference. Set only on a complete run whose manifests could all be read |
| `logicalBytesByWorkload`                      | The same, per workload                                                                                  |
| `versionsVisible`, `incompleteUploadsVisible` | `false` when the credentials cannot list versions or multipart uploads. Those figures are then incomplete |
| `complete`, `continuationToken`               | Whether the run finished. The token resumes it when it did not                                          |
| `listRequests`                                | S3 requests made so far, across resumed calls                                                           |
| `target`, `startedAt`, `measuredAt`           | `primary` or the target's `targetId`. When the first call started, and when this call finished          |

A run that stops early returns rather than throws, so a scheduler can store the token and continue on its next tick. A run that fails on an S3 error throws, and the error carries a token for the last page counted:

```typescript
import { getStorageUsageToken } from '@wisecom/atlas-sdk';

let continuationToken: string | undefined;
let usage;
try {
  usage = await atlas.getStorageUsage({ continuationToken, maxListRequests: 1000 });
} catch (err) {
  continuationToken = getStorageUsageToken(err) ?? continuationToken;
  throw err;
}
```

Invalid options, and a token issued for a different tenant, target, or breakdown, throw `ConfigError` before any request is made. Such a call carries no token.

## Progress and cancellation

Every Outlook, OneDrive, and SharePoint `backup`, `restore`, `save`, and `verify` method accepts:

| Option       | Type                                      | Description                                                                                       |
| ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `onProgress` | `(event: OperationProgressEvent) => void` | Receives discovery, per-item, finalization, and terminal events                                   |
| `signal`     | `AbortSignal`                             | Requests cancellation. The transfer in flight ends, and the run stops at a safe boundary           |

```typescript
const controller = new AbortController();

const result = await atlas.outlook.backup('user@example.com', {
  signal: controller.signal,
  onProgress(event) {
    console.log(event.phase, event.processed, event.total, event.current);
    if (event.processed >= 1000) controller.abort();
  },
});

if (result.interrupted) {
  console.log('Stopped safely. Rerun to continue from the last committed delta.');
}
```

`OperationProgressEvent` has the same shape for every workload:

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

The callback runs inline, so keep it fast and hand network or database writes to your own queue.

Cancellation returns normally with `interrupted: true` and does not throw. Restore and save results contain partial counts, and a save still finalizes a valid zip with the files it completed. A backup that was interrupted does not advance the delta cursor of the folder, drive, or library it was processing, so the next run replays that unit. Completed units stay committed.

If the signal is already aborted when the call starts, no `discovering` event is emitted. The stream contains `finalizing` followed by `interrupted`.

### Outlook escalation

`atlas.outlook.backup` also accepts `hardStopSignal`, which the CLI wires to a second Ctrl+C:

```typescript
const graceful = new AbortController();
const immediate = new AbortController();

process.on('SIGTERM', () => graceful.abort());
setTimeout(() => immediate.abort(), 30_000); // shutdown deadline

const result = await atlas.outlook.backup('user@example.com', {
  signal: graceful.signal,
  hardStopSignal: immediate.signal,
});
```

| Signal           | Effect                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`         | Finishes the page in flight, stores its attachments, and saves the delta link for every completed folder. The next run resumes from there                    |
| `hardStopSignal` | Drops the page in flight and its pending attachments. The affected folder keeps its previous delta link and is enumerated again on the next run              |

Both return `interrupted: true` and keep the snapshot manifest written so far. `hardStopSignal` trades re-enumeration of one folder for a faster exit, so use it when a deadline matters more than the lost work.

OneDrive and SharePoint accept `signal` only. It reaches the transfer itself: a cancelled run aborts the chunk request in flight, skips the retry backoff, and closes a historical version's stream. A file transfer is the long unit of work for these workloads, so no escalation signal is needed.

Some operations cannot be cancelled mid-request. Small-file content under 64 MiB goes through the Graph SDK client, which is bounded by its own 60-second request timeout. Every mail operation also goes through that client. Cancelling those waits for the item in flight. The CLI has no equivalent for drive backups, so Ctrl+C there behaves as before.

## Outlook options and results

### Folder coverage

`backup()` walks every mail folder at any depth, including Drafts, Outbox, Junk Email, and folders Exchange marks hidden. Pass `excludeJunk` to skip Junk Email and its subfolders:

```typescript
const result = await atlas.outlook.backup('user@example.com', { excludeJunk: true });

for (const folder of result.summary.excludedFolders) {
  console.log(`${folder.folderPath} not captured: ${folder.reason}`);
}
```

`reason` is `'junk-excluded'`, `'hidden-system-folder'`, `'recoverable-items-not-mail'`, or `'recoverable-items-unrecognised'`. The manifest stores the same list as `excludedFolders`, so you can check a stored snapshot to see whether a folder was captured. `MailFolder.isHidden` marks folders Exchange hides.

#### Recoverable Items

`includeRecoverableItems` also captures hard-deleted and hold-retained mail from the Exchange dumpster. Delta queries never report that mail, so the option is off by default:

```typescript
await atlas.outlook.backup('user@example.com', { includeRecoverableItems: true });
```

`Deletions`, `Purges`, `DiscoveryHolds`, and `SubstrateHolds` are captured. `Versions`, `Calendar Logging`, and `Audits` are reported in `excludedFolders` instead. Captured entries carry `recoverableItems: true`. `restore()` and `save()` skip them unless `includeRecoverableItems` is set:

```typescript
const restorable = manifest.entries.filter((entry) => entry.recoverableItems !== true);

await atlas.outlook.restore('snapshot-id', { includeRecoverableItems: true });
```

With the option off, the request volume matches earlier runs. Storing purged mail has compliance consequences. See [Recoverable Items and legal hold](/security#recoverable-items-and-legal-hold).

### Snapshot folders

Outlook manifests carry `folders`, the folders the run selected. A client can build a folder pane from a snapshot alone:

```typescript
const snapshot = await atlas.outlook.getSnapshotDetail('snapshot-id');

const inbox = snapshot?.folders?.find((folder) => folder.wellKnownName === 'inbox');
const inboxEntries = snapshot?.entries.filter((entry) => entry.folderId === inbox?.folderId);
```

Each folder record has `folderId`, `displayName`, `folderPath`, `parentFolderId`, and `totalItemCount`. `isHidden`, `isRecoverableItems`, and `wellKnownName` appear when set.

`wellKnownName` is the Graph well-known name: `inbox`, `drafts`, `sentitems`, `deleteditems`, `junkemail`, `archive`, `outbox`, `conversationhistory`, `searchfolders`, or `recoverableitemsdeletions`. Other folders have no value. Display names are localized and user folders can reuse any name, so match on `wellKnownName`, not `displayName`.

Graph v1.0 has no `wellKnownName` property, so Atlas resolves each name to a folder ID with one request per name per backup, charged to the `outlook` pool. A name the mailbox does not have is not tagged. Other failures are reported through `folderErrors`.

An incremental manifest lists only the folders its own run selected. Entries carried over from earlier snapshots can name a folder that only an older manifest lists. Manifests written by earlier releases have no `folders`.

### Message sender

Outlook manifest entries carry `from`, the sender Outlook displays, including delegated and send-as mail. It comes from the delta page, so it costs no extra request:

```typescript
const snapshot = await atlas.outlook.getSnapshotDetail('snapshot-id');

for (const entry of snapshot?.entries ?? []) {
  entry.from?.address; // 'ada@example.com'
  entry.from?.name; // 'Ada Example', absent when Graph has no display name
}
```

`from` is absent on drafts and system items without a sender, and on entries written by earlier releases. Treat a missing value as an unknown sender. It is personal data, so restrict who can read the output of any listing that includes it.

### Shared mailbox identity

`mailboxPurpose` is `'user' | 'linked' | 'shared' | 'room' | 'equipment' | 'others'`, taken from Graph `mailboxSettings.userPurpose`. A value of `'shared'` identifies a shared mailbox. It appears on:

- `TenantMailbox.mailboxPurpose` from `listAvailableMailboxes()`.
- `MailboxSummary.mailboxPurpose` from `listMailboxes()`. Taken from the newest manifest that recorded it, so a failed lookup in the latest backup does not blank the field.
- `Manifest.mailboxPurpose` from `backup()`, `listSnapshots()`, and `getSnapshotDetail()`. Recorded at backup time.

When the `mailboxSettings` lookup fails during discovery, `TenantMailbox.purposeLookupError` holds the Graph error message. A mailbox with that field set may still be shared, so do not treat it as an unlicensed user mailbox when deciding what to back up.

```typescript
const mailboxes = await atlas.outlook.listAvailableMailboxes();
const shared = mailboxes.filter((mb) => mb.mailboxPurpose === 'shared');
```

### In-Place Archive coverage

`TenantMailbox.hasInPlaceArchive` reports whether a mailbox has an In-Place Archive (Online Archive). **Archive stores are not backed up.** Graph cannot read archive mailboxes, so a successful backup of such a mailbox does not cover all its mail. See [In-Place Archive is out of scope](/security#in-place-archive-is-out-of-scope).

The field has three states:

```typescript
const mailboxes = await atlas.outlook.listAvailableMailboxes();

const uncovered = mailboxes.filter((mb) => mb.hasInPlaceArchive === true);
const unknown = mailboxes.filter((mb) => mb.hasInPlaceArchive === undefined);
```

`undefined` means unknown, not "no archive". The value comes from the `Has Archive` column of the mailbox usage report, which requires the optional `Reports.Read.All` permission. Treating `undefined` as covered reports coverage that Atlas has not confirmed. No per-mailbox Graph property exposes archive state on v1.0 or beta.

### Restore options and result

`atlas.outlook.restore` and `atlas.outlook.restoreMailbox` accept:

| Option          | Type     | Description                                                |
| --------------- | -------- | ---------------------------------------------------------- |
| `folderName`    | `string` | Restore only this folder and its subfolders (name or path) |
| `messageRef`    | `string` | Restore one message by index or ID                         |
| `targetMailbox` | `string` | Target mailbox for a cross-mailbox restore                 |
| `startDate`     | `Date`   | Include snapshots on or after this date                    |
| `endDate`       | `Date`   | Include snapshots on or before this date                   |

Both return a `RestoreResult`:

```typescript
interface RestoreResult {
  snapshotId: string;
  restoredCount: number;
  attachmentCount: number;
  errorCount: number;
  attachmentErrorCount: number;
  errors: string[];
  verificationWarnings: string[];
  messages: RestoredMessageReport[];
  restoreFolderName: string;
  graphCost?: OperationCost; // SDK only
  interrupted: boolean;
}

interface RestoredMessageReport {
  objectId: string;
  attachmentsExpected: { file: number; inline: number };
  attachmentsUploaded: { file: number; inline: number };
  attachmentsFailed: number;
}
```

| Field                  | Description                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `errorCount`           | Message-level failures. Equals `errors.length`                                                               |
| `attachmentErrorCount` | Attachment-level failures, as a count. Details are logged during restore                                     |
| `errors`               | Detail for each message-level failure                                                                        |
| `verificationWarnings` | Per-folder warnings, including API failures that prevented count confirmation, and one line for each message that received fewer attachments than its snapshot holds |
| `messages`             | One report per message created in the target mailbox, with attachment counts only. No names or content       |

A message's expected attachments come from its snapshot: the manifest's attachment list for a Graph JSON entry, or the parts parsed from stored MIME for a MIME entry. `inline` counts parts embedded in the body (`isInline: true`). `file` counts attachments Outlook lists. Compare `attachmentsUploaded` with `attachmentsExpected` to find a message that lost attachments. `attachmentsFailed` counts upload errors, which also appear in `errors`. A legacy attachment whose content was never stored is skipped without an error and appears only as a gap between the two counts.

The split comes from the same MIME parse that drives the upload. It shows what Atlas restored, not whether the parse classified every part correctly.

### Save options

`atlas.outlook.save` and `atlas.outlook.saveMailbox` accept:

| Option               | Type       | Description                                                      |
| -------------------- | ---------- | ---------------------------------------------------------------- |
| `folderName`         | `string`   | Save only this folder and its subfolders (name or path)          |
| `messageRef`         | `string`   | Save one message by index or ID                                  |
| `startDate`          | `Date`     | Include snapshots on or after this date                          |
| `endDate`            | `Date`     | Include snapshots on or before this date                         |
| `outputPath`         | `string`   | Output zip path. Default `Restore-<timestamp>.zip`               |
| `skipIntegrityCheck` | `boolean`  | Skip the SHA-256 check of each object. Default `false`           |
| `output`             | `Writable` | Stream the archive to this destination instead of a file         |

Both return a `SaveResult`:

```typescript
interface SaveResult {
  snapshotId: string;
  savedCount: number;
  attachmentCount: number;
  errorCount: number;
  errors: string[];
  outputPath: string;
  totalBytes: number;
  integrityFailures: string[];
  interrupted: boolean;
}
```

## Streaming exports

`save()` and `saveMailbox()` accept an `output` stream instead of a path. The export goes directly to its consumer and is not staged on the exporting machine's disk. Use this for read-only or ephemeral filesystems, and for exports large enough that writing them twice costs real time.

```typescript
import express from 'express';
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const app = express();
const atlas = createAtlasInstance({
  /* ...credentials... */
});

app.get('/export/:snapshotId', async (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="export.zip"');

  try {
    const result = await atlas.outlook.save(req.params.snapshotId, { output: res });
    log.info({ saved: result.savedCount, failures: result.integrityFailures }, 'export served');
  } catch (err) {
    // The response is already destroyed, so the client sees a failed transfer.
    log.error({ err }, 'export failed');
  }
});
```

The drive workloads accept the same option:

```typescript
await atlas.onedrive.save('user@example.com', { snapshotId, output: res });
await atlas.sharepoint.save('https://contoso.sharepoint.com/sites/Engineering', {
  snapshotId,
  output: res,
});
```

Any Node.js `Writable` works: an HTTP response, an upload stream, or a compressor.

| Behavior                            | Stream export                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `outputPath` in the result          | Empty string. There is no file                                                                                      |
| Counts, errors, `integrityFailures` | Reported the same way as for a file export                                                                          |
| Failed run                          | The stream is destroyed, not ended. This includes failures during setup, before any bytes are written               |
| Interrupted run                     | The stream is destroyed without finalizing the archive. The result reports `interrupted: true`                     |
| `output` with `outputPath`          | Rejected with `ConfigError`. Atlas writes one archive, and silently dropping a value would lose the export          |

A destroyed stream is intentional. Ending it would give the consumer a short archive that opens like a complete one. Over HTTP, the client sees the transfer break, so treat a body that arrived without a completed request as a failed export. Headers are already sent, so the status code cannot report the failure. Check the result, or the absence of one, on the server.

Memory use stays bounded to one message or file. Each entry is fetched, decrypted, compressed, and flushed before the next starts. A slow consumer applies backpressure instead of growing the archive in memory.

### When the consumer disconnects

If the client disconnects during an export, Atlas ends the run:

- The promise rejects with the destination failure. It does not wait for a `finish` event that will not come.
- No further entries are downloaded. The run stops at the entry it could not write.
- The archive is not finalized, so the bytes already received are not a valid zip.

Over HTTP, the client's disconnect means nobody may be listening for the rejection. Handle it on the server anyway. The rejection is the signal that the run stopped, and it is the only record that the export ended early.

## Drive options and results

### Restore

The drive restore methods accept `destination`, `inPlace`, and `renameTo`, along with `conflictBehavior`. By default they restore under a generated `Restore-<timestamp>` root and do not overwrite the original paths. Pass `inPlace: true` to write back to the original locations:

```typescript
const snapshotId = 'od-snap-123';
await atlas.onedrive.restore('owner-id', { snapshotId }); // /Restore-2026-08-27T10-15-30/...
await atlas.onedrive.restore('owner-id', { snapshotId, destination: '/DR-drill' });
await atlas.onedrive.restore('owner-id', { snapshotId, inPlace: true });
```

`restore` and `save` on both drive workloads require an options object with `snapshotId`. TypeScript enforces this. A JavaScript caller that omits it gets a `TypeError` that names the method. `verify` takes its options optionally.

### Version restore

`restoreVersion()` pushes stored file versions back into a live drive or library. It is available on `atlas.onedrive` and `atlas.sharepoint`:

```typescript
// One exact version. List versions first to see what exists.
const versions = await atlas.onedrive.listFileVersions('owner-id', '/Documents/report.docx');
const previous = versions.at(-2);
if (!previous) throw new Error('No older version is stored for this file');

const result = await atlas.onedrive.restoreVersion('owner-id', {
  fileRef: '/Documents/report.docx',
  versionId: previous.versionId,
});

// Roll one folder back to its state at a point in time
await atlas.sharepoint.restoreVersion('site-id', {
  before: new Date('2026-03-10T00:00:00Z'),
  pathPrefix: '/Shared Documents/Projects',
  placement: 'in-place',
});
```

| Option       | Description                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| `fileRef`    | Graph item ID, rooted path, or bare filename. Required with `versionId`                  |
| `versionId`  | Exact stored version, from `listFileVersions()`                                          |
| `before`     | `Date`. Restores each file's newest version at or before this instant                    |
| `pathPrefix` | Limits a `before` rollback to one folder and its contents                                |
| `placement`  | `'copy'` (default) writes a sibling file. `'in-place'` uploads over the original           |

Pass either `fileRef` with `versionId`, or `before`. The result has `filesRestored`, `filesSkipped`, the `placement` used, and a `restored` array of `{ fileId, versionId, lastModifiedAt, sizeBytes, restoredTo }`. A file with no version at or before the cutoff appears in `errors` and counts as skipped, so a partial rollback is visible:

```typescript
if (result.filesSkipped > 0) {
  for (const reason of result.errors) console.warn(reason);
}
```

Neither placement destroys data. `'copy'` never touches the live file. `'in-place'` uploads a new version, and Microsoft 365 keeps the replaced content in the file's own version history. Restored files carry the modification time of the version, not the restore time.

Atlas uploads its own checksum-verified bytes instead of calling Graph's `restoreVersion`. Graph's call only works on versions the service still holds and cannot be checked against the manifest. See [the CLI reference](/reference/cli#atlas-onedrive) for details.

### Drive item metadata

Drive manifest entries store metadata that a restore cannot rebuild from bytes alone. Read it from the manifest returned by `listSnapshots()`:

```typescript
const snapshot = (await atlas.onedrive.listSnapshots('owner-id')).find(
  (manifest) => manifest.snapshotId === snapshotId,
);

for (const entry of snapshot?.entries ?? []) {
  entry.fileSystemInfo?.createdAt; // original client timestamp, reapplied on restore
  entry.createdBy?.displayName; // author, recorded for audit only
  entry.lastModifiedBy?.email;
}
```

`fileSystemInfo` holds the client-reported timestamps from the Graph `fileSystemInfo` facet. A restore reapplies that pair. `lastModifiedAt` stays the service-side value, which reflects the restore after it runs. Authors and version authors are captured but not reapplied. Sharing permissions are not captured. See [What a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

These fields are absent on manifests written before 4.1.0.

## Object Lock

Pass `objectLockRequest` to a backup method to apply WORM retention. Atlas derives the rest of the policy from it, so the SDK and CLI produce the same result for the same settings:

```typescript
await atlas.outlook.backup('user@example.com', {
  objectLockRequest: { mode: 'COMPLIANCE', retentionDays: 30 },
});

await atlas.onedrive.backup('owner-id', {
  objectLockRequest: { mode: 'GOVERNANCE', retentionDays: 30 },
});
```

| Field           | Behavior                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `mode`          | `GOVERNANCE` (privileged users can shorten retention) or `COMPLIANCE` (nobody can, including root). Default `GOVERNANCE`        |
| `retentionDays` | Converted to an absolute `retainUntil` timestamp in UTC when the run starts                                                     |

Outlook applies the policy to each stored object. OneDrive and SharePoint set the bucket's default retention, so every new object version inherits it. Writes fail closed: if a lock policy is requested and the bucket has versioning or Object Lock disabled, or does not support the mode, the write throws instead of storing unprotected data.

## Batch processing

To back up several mailboxes from a shell, list them with `atlas outlook mailboxes` and run `atlas outlook backup -m <id>` for each one in your scheduler. The CLI handles one mailbox per invocation.

In the SDK, create one instance and iterate sequentially. Each backup, restore, or save sends many Graph requests. Running mailboxes through `Promise.all` multiplies the request rate and triggers throttling (HTTP 429). Atlas retries throttled requests with backoff, but a sequential loop finishes sooner and more predictably:

```typescript
const mailboxIds = ['alice@example.com', 'bob@example.com', 'carol@example.com'];

for (const mailboxId of mailboxIds) {
  const result = await atlas.outlook.backup(mailboxId);
  console.log(`${mailboxId}: snapshot ${result.snapshot.id}`);
}
```

## Replication

Replication copies snapshots to a secondary S3 endpoint and restores them after a loss. A `StorageTarget` needs only S3 credentials and the shared passphrase. It does not need Microsoft 365 credentials, so replication runs entirely between S3 endpoints.

```typescript
import { createAtlasInstance, createStorageTarget } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  /* primary config */
});

const offsite = createStorageTarget({
  targetId: 'offsite-dr',
  s3Endpoint: 'https://offsite.example.internal',
  s3AccessKey: '<access-key>',
  s3SecretKey: '<secret-key>',
  encryptionPassphrase: '<same-passphrase-as-primary>',
});

// Copy one snapshot to one or more targets
const results = await atlas.replicateSnapshot('snapshot-id', [offsite]);

// Copy every unreplicated snapshot for a mailbox
const mailboxResults = await atlas.replicateMailbox('user@example.com', [offsite]);

// Replication status for one snapshot, or every snapshot for one owner
const status = await atlas.getReplicationStatus('snapshot-id');
const ownerStatus = await atlas.getReplicationStatusByOwner('user@example.com');

// Recovery from a replica
await atlas.rehydrateSnapshot('snapshot-id', offsite);
await atlas.rehydrateMailbox('user@example.com', offsite);

// Full tenant recovery, reported per workload
const recovery = await atlas.rehydrateTenant(offsite);
for (const { workload, result } of recovery.workloads) {
  console.log(workload, result.objectsCopied, result.objectsSkipped);
}
console.log(recovery.total.status);
```

Replication skips objects that already exist on the target. A snapshot whose manifest already exists on the target is reported as skipped, not copied again. `replicateSnapshot` returns an array because it can target several destinations.

`createStorageTarget` accepts a `StorageTargetConfig`:

| Option                 | Type                                   | Description                                                                                                                 |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `targetId`             | `string`                               | Stable ID. Derived from the endpoint when omitted                                                                           |
| `s3Endpoint`           | `string`                               | S3 endpoint URL                                                                                                             |
| `s3AccessKey`          | `string`                               | S3 access key                                                                                                               |
| `s3SecretKey`          | `string`                               | S3 secret key                                                                                                               |
| `s3Region`             | `string`                               | S3 region. Default `us-east-1`                                                                                              |
| `encryptionPassphrase` | `string`                               | Must match the primary passphrase. Replicas share its encryption model                                                      |
| `onStorageRequest`     | `(event: StorageRequestEvent) => void` | Receives one event per S3 request sent to this target, with `target` set to `targetId`. See [Storage request events](/reference/storage-request-events) |

## Key re-wrap

`rewrapDataKey(newPassphrase?)` re-wraps the tenant's data key under a new passphrase, or under the configured one with current KDF parameters. Use it to move a tenant bootstrapped with weaker scrypt parameters to current ones.

```typescript
const result = await atlas.rewrapDataKey(newPassphrase);

console.log(result.passphraseChanged, result.previousKdfId, result.kdfId);
```

| Field               | Type      | Description                                                       |
| ------------------- | --------- | ----------------------------------------------------------------- |
| `tenantId`          | `string`  | Tenant whose key was re-wrapped                                   |
| `passphraseChanged` | `boolean` | `false` when the call re-wrapped under the configured passphrase  |
| `previousKdfId`     | `number`  | KDF the wrapper used before the call                              |
| `kdfId`             | `number`  | KDF the new wrapper uses                                          |

The data key does not change, so nothing in the bucket is re-encrypted and every snapshot stays readable. **This rotates the wrapper, not the key.** An attacker who already holds the data key or plaintext is not affected. Use re-wrap after a leaked passphrase, not after a compromised bucket.

Buckets are versioned, and noncurrent versions expire after 30 days. Until they expire, someone with the old passphrase and permission to read object versions can still unwrap the data key from the old wrapper. Treat the rotation as complete only after that version expires, or after the leaked reader's `s3:GetObjectVersion` permission is revoked.

A wrong current passphrase is rejected before anything is written. After the write, the blob is read back and unwrapped before the promise resolves, so a resolved call means the tenant opens with the new passphrase. If that check fails, the previous wrapper is restored and the call rejects.

Update the instance configuration afterwards. Nothing reads the new passphrase until you do, and an instance still built with the old passphrase fails its next operation.

## Graph cost tracking

`backup`, `restore`, `restoreMailbox`, and `checkMailboxStatus` return `graphCost`, the number of Graph requests they made, broken down by service pool. Other Graph calls such as `listAvailableMailboxes()` use quota but do not return this field. Account for them separately when budgeting.

```typescript
const result = await atlas.outlook.backup('user@example.com');

console.log(result.graphCost);
// {
//   requestsTotal: 852,
//   byService: {
//     outlook: { requests: 847, resourceUnits: 847, uploadBytes: 0 },
//     identity: { requests: 5, resourceUnits: 5, uploadBytes: 0 },
//   },
//   requestsByType: {
//     // Keys are request-type labels. They are recorded exactly as Atlas emits them.
//     delta_sync: 312, fetch_attachments: 530,
//     list_folders: 5, mailbox_exists: 2, list_users: 3,
//   },
//   elapsedMs: 45200,
// }
```

`graphCost` is returned by `atlas.outlook.backup`, `atlas.outlook.restore`, `atlas.outlook.restoreMailbox`, and `atlas.outlook.checkMailboxStatus`. The values in the example are illustrative.

### What counts

Each request sent through the Graph client is counted once, as it is sent. Pagination and retries both count:

- **Every page.** A delta sync that follows `@odata.nextLink` across 40 pages counts 40.
- **Every attempt.** A call throttled twice and then succeeding counts 3.

`requestsByType` labels each request with the connector operation that issued it. A paginated `delta_sync` shows all its pages under one label.

### Cost when an operation fails

A failed run can be the most expensive run in a job. A delta sync that fails on page 400, or a request that uses its whole retry budget against a 429, may use more quota than any successful run. The cost is attached to the thrown error and read with `getGraphCost`:

```typescript
import { createAtlasInstance, getGraphCost } from '@wisecom/atlas-sdk';

try {
  const result = await atlas.outlook.backup('user@example.com');
  recordCost(result.graphCost);
} catch (err) {
  // Requests spent before the failure. Undefined when the error did not come from a tracked SDK operation.
  const cost = getGraphCost(err);
  if (cost) recordCost(cost);
  throw err;
}
```

The error is rethrown unchanged, so `instanceof` checks and catch filters keep working. The cost is a non-enumerable property, so logging and serialization are unaffected.

:::danger
A scheduler that reads cost only on success treats the most expensive runs as free. It then queues the next mailbox into a tenant that is already throttled, which causes another 429 and extends the throttle.
:::

### OperationCost type

```typescript
interface OperationCost {
  requestsTotal: number;
  byService: Partial<Record<GraphServicePool, ServicePoolCost>>;
  requestsByType: Record<string, number>;
  elapsedMs: number;
}

interface ServicePoolCost {
  requests: number; // API calls made against this pool
  resourceUnits: number; // Resource units used. Equals requests for the flat-cost Outlook pool
  uploadBytes: number; // Request body bytes. Relevant for the Outlook 150 MB per 5 minute limit
}

type GraphServicePool = 'outlook' | 'sharepoint_onedrive' | 'identity';
```

`byService` lists only the pools the operation used. A mail backup usually has `outlook` and `identity` entries.

### GRAPH_SERVICE_LIMITS

The official throttling limits are exported as a frozen constant, so a scheduler can use the same values as Atlas:

```typescript
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-sdk';

const outlook = GRAPH_SERVICE_LIMITS.outlook;
// outlook.requestsPerWindow      => 10,000
// outlook.windowDurationMs       => 600,000 (10 min)
// outlook.maxConcurrentRequests  => 4

const sp = GRAPH_SERVICE_LIMITS.sharepoint_onedrive;
// sp.resourceUnitsPerMinute['0-1000'] => 1,250
// sp.deltaWithTokenCost               => 1

const identity = GRAPH_SERVICE_LIMITS.identity;
// identity.resourceUnitsPer10s['L']   => 8,000
// identity.usersListCost              => 2
```

See [Graph API rate limits](/operations/graph-rate-limits) for all pool limits, cost models, and Microsoft documentation links.

### Scheduling example

A common pattern is one queued job per mailbox. After each run, use `graphCost` to set a cooldown before the next job starts. This example uses pg-boss:

```typescript
import { createAtlasInstance, getGraphCost, GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-sdk';
import type { OperationCost } from '@wisecom/atlas-sdk';
import PgBoss from 'pg-boss';

const boss = new PgBoss(DATABASE_URL);

boss.work('backup-mailbox', async (job) => {
  const { tenantConfig, mailboxId } = job.data;
  const atlas = createAtlasInstance(tenantConfig);

  let cost: OperationCost | undefined;
  try {
    const result = await atlas.outlook.backup(mailboxId);
    cost = result.graphCost;
  } catch (err) {
    // A failed run often uses more quota than a successful one. Record it, then rethrow.
    cost = getGraphCost(err);
    throw err;
  } finally {
    if (cost) {
      await db.query(
        `INSERT INTO backup_costs
           (mailbox_id, outlook_requests, identity_requests, elapsed_ms, completed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          mailboxId,
          cost.byService.outlook?.requests ?? 0,
          cost.byService.identity?.requests ?? 0,
          cost.elapsedMs,
        ],
      );

      // Cooldown from the Outlook pool limit, the bottleneck for mail backup
      const outlookLimits = GRAPH_SERVICE_LIMITS.outlook;
      const outlookUsed = cost.byService.outlook?.requests ?? 0;
      const usageRatio = outlookUsed / outlookLimits.requestsPerWindow;
      const cooldownMs = Math.ceil(usageRatio * outlookLimits.windowDurationMs);

      // Re-enqueue after the cooldown. retryLimit: 0 because this job is the retry.
      // Otherwise pg-boss schedules its own retry, and the tenant is hit twice.
      await boss.send('backup-mailbox', job.data, {
        startAfter: new Date(Date.now() + cooldownMs),
        retryLimit: 0,
      });
    }
  }
});
```

The Outlook pool limit applies per mailbox, so each mailbox's cooldown is independent. Workers for different mailboxes do not share Outlook quota.

The `sharepoint_onedrive` pool applies per tenant. For OneDrive jobs, add up `resourceUnits` across the tenant's owners and compare the total with `GRAPH_SERVICE_LIMITS.sharepoint_onedrive.resourceUnitsPerMinute['<tier>']` before scheduling the next job.

## Errors

Every deliberate Atlas failure is an `AtlasError` with a stable `code`. Branch on the class or the code. Do not branch on the message, because wording changes between releases.

```typescript
import { MailboxNotLicensedError, WrongPassphraseError, AtlasError } from '@wisecom/atlas-sdk';

try {
  await atlas.outlook.backup('user@example.com');
} catch (err) {
  if (err instanceof MailboxNotLicensedError) {
    await reassign_license('user@example.com'); // retry after a license is assigned
  } else if (err instanceof WrongPassphraseError) {
    throw err; // Do not retry. The data is intact, but the key is wrong
  } else if (err instanceof AtlasError) {
    logger.error({ code: err.code, cause: err.cause }, 'Atlas backup failed');
  }
}
```

| Class                               | `code`                       | Meaning                                                                    |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `AtlasError`                        | any of the below             | Base class. Catch it to separate deliberate failures from bugs              |
| `AuthError`                         | `ATLAS_AUTH_DENIED`          | Graph or storage refused the call: missing permission or admin consent      |
| `MailboxNotLicensedError`           | `ATLAS_MAILBOX_NOT_LICENSED` | No Exchange Online license, so Graph does not serve the mailbox             |
| `NotFoundError`                     | `ATLAS_NOT_FOUND`            | Snapshot, mailbox, drive, site, or object does not exist                    |
| `ThrottledError`                    | `ATLAS_THROTTLED`            | Graph returned 429 through all 12 retries. See `retry_after_ms`             |
| `WrongPassphraseError`              | `ATLAS_WRONG_PASSPHRASE`     | The passphrase could not unwrap the data key                                |
| `ObjectLockRetainedError`           | `ATLAS_OBJECT_LOCK_RETAINED` | Object is under retention or a legal hold. Its `key` is set                 |
| `StorageError`                      | `ATLAS_STORAGE_FAILURE`      | Storage failed for a reason other than permission, retention, or absence    |
| `ConfigError`                       | `ATLAS_CONFIG_INVALID`       | Credentials, endpoint, passphrase, or tenant is missing or unusable         |
| `ObjectLockVersioningDisabledError` | `ATLAS_CONFIG_INVALID`       | Immutability requested, but bucket versioning is off                        |
| `ObjectLockUnsupportedError`        | `ATLAS_CONFIG_INVALID`       | Immutability requested, but the bucket has no Object Lock                   |
| `ObjectLockModeRejectedError`       | `ATLAS_CONFIG_INVALID`       | The backend rejected the requested retention mode                           |
| `PreconditionFailedError`           | `ATLAS_STORAGE_FAILURE`      | A conditional write lost a race (HTTP 412)                                  |

Every error keeps the underlying failure in `cause`, so the Graph or AWS SDK error is available for logging. Branching does not depend on it.

`ThrottledError` is the exception to the camelCase rule. It exposes the last `Retry-After` value Graph sent as `retry_after_ms`, in milliseconds, or `undefined` when Graph sent none. It is thrown after 12 retries. Retries back off exponentially, capped at 5 minutes per wait, so with no `Retry-After` the waits add up to roughly 23 minutes. The CLI exits with code `3` for this error.

`WrongPassphraseError` needs a note. AES-GCM reports a wrong key and damaged ciphertext as the same authentication failure. Atlas names the passphrase because it is the likelier cause and the only one an operator can act on. The raw crypto error stays in `cause`. If the passphrase is known to be correct for that tenant, treat the error as a possible integrity problem and run `atlas verify` on the snapshot.

## Exports

`@wisecom/atlas-sdk` exports an explicit list. Internal domain types and ports are not exported. Infer other result types from `AtlasInstance` rather than importing internal models.

- **Factories and values:** `createAtlasInstance`, `createStorageTarget`, `getGraphCost`, `getStorageUsageToken`, `GRAPH_SERVICE_LIMITS`
- **Instance types:** `AtlasInstance`, `AtlasInstanceConfig`, `LogSink`, `LogFields`
- **Sub-API types:** `OutlookApi`, `OneDriveApi`, `SharePointApi`
- **Workload options and results:** the `Outlook*`, `OneDriveSdk*`, and `SharePointSdk*` types each API uses
- **Operation control:** `SdkOperationOptions`, `OperationProgressEvent`, `OperationProgressCallback`, `OperationProgressPhase`
- **Storage targets and usage:** `StorageTarget`, `StorageTargetConfig`, `StorageUsage`, `StorageUsageTotals`, `StorageOwnerUsage`, `StorageUsageOptions`, `StorageUsageBreakdown`, `StorageUsageWorkload`, `LogicalWorkload`
- **Storage request events:** `StorageRequestEvent`, `StorageRequestObserver`, `StorageRequestWorkload`, `StorageKeyClass`
- **Shared enums and requests:** `ObjectLockMode`, `ObjectLockRequest`, `BackupSyncMode`, `RehydrationWorkload`, `GraphServicePool`
- **Graph cost types:** `OperationCost`, `ServicePoolCost`, `GraphServiceLimits`
- **Errors:** `AtlasError`, `AtlasErrorCode`, `AuthError`, `MailboxNotLicensedError`, `NotFoundError`, `ThrottledError`, `WrongPassphraseError`, `ObjectLockRetainedError`, `StorageError`, `ConfigError`, `ObjectLockVersioningDisabledError`, `ObjectLockUnsupportedError`, `ObjectLockModeRejectedError`, `PreconditionFailedError`

## See also

- [CLI commands](/reference/cli)
- [SDK examples](/reference/examples)
- [Storage request events](/reference/storage-request-events)
- [Security](/security)
- [Migrating to v6](/migration/v6)
