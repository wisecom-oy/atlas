---
description: 'Typed reference for @wisecom/atlas-sdk: configuration, every workload method with its options and results, progress, cancellation, and errors.'
---

# SDK reference

`@wisecom/atlas-sdk` embeds Atlas in a Node.js application: multi-tenant services, custom schedulers, portals, and automation that needs typed control over backup, restore, save, and verification. It bundles every internal module, so one install is enough. For shell use, see [CLI commands](/reference/cli).

```bash
npm add @wisecom/atlas-sdk
```

The SDK requires Node.js 22.8 or later. `await using` needs TypeScript 5.2 or later.

## Quick start

```ts
import { createAtlasInstance } from '@wisecom/atlas-sdk';

await using atlas = createAtlasInstance({
  tenantId: '<tenant-id>',
  clientId: '<client-id>',
  clientSecret: '<client-secret>',
  s3Endpoint: 'https://s3.example.com',
  s3AccessKey: '<access-key>',
  s3SecretKey: '<secret-key>',
  encryptionPassphrase: '<encryption-passphrase>',
});

const result = await atlas.outlook.backup('user@example.com');
console.log(result.snapshot.id, result.summary.stored);
```

Without `await using`, call `atlas.dispose()` in a `finally` block. See [Instance lifecycle](#instance-lifecycle).

The API is grouped by workload (`atlas.outlook`, `atlas.onedrive`, `atlas.sharepoint`, `atlas.teams`, `atlas.contacts`, `atlas.calendar`), with tenant-wide methods such as `getBucketStats`, `getStorageUsage`, and `rewrapDataKey` on the instance itself.

## Configuration

`createAtlasInstance(config)` takes every setting explicitly. The SDK reads nothing from the environment, `.env`, or config files (the CLI, `@wisecom/atlas-cli`, does), so a stale file or another tenant's configuration can never select credentials.

| Option                 | Type                                   | Required | Description                                                                                                                       |
| ---------------------- | -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tenantId`             | `string`                               | Yes      | Microsoft Entra tenant ID. Bound at creation, so every call stays in this tenant                                                  |
| `clientId`             | `string`                               | Yes      | Application (client) ID of the app registration                                                                                   |
| `clientSecret`         | `string`                               | Yes      | Client secret of the app registration                                                                                             |
| `s3Endpoint`           | `string`                               | Yes      | Absolute HTTP or HTTPS URL with no embedded credentials, query, or fragment. Use HTTPS across untrusted networks                   |
| `s3AccessKey`          | `string`                               | Yes      | S3 access key                                                                                                                     |
| `s3SecretKey`          | `string`                               | Yes      | S3 secret key                                                                                                                     |
| `s3Region`             | `string`                               | No       | S3 region. Default `us-east-1`                                                                                                    |
| `s3Bucket`             | `string`                               | No       | Bucket to use instead of `atlas-{tenantId}`. Bound to `tenantId` and never created. See [Bucket override](#bucket-override)       |
| `encryptionPassphrase` | `string`                               | Yes      | Protects the tenant's data key. At least 14 UTF-8 bytes. Must match the passphrase of existing backups                            |
| `logger`               | `LogSink`                              | No       | Receives SDK log lines. The SDK is silent without it. See [Logging](#logging)                                                     |
| `onStorageRequest`     | `(event: StorageRequestEvent) => void` | No       | Receives one event per S3 request. See [Storage request events](#storage-request-events)                                          |
| `throttleCoordinator`  | `ThrottleCoordinator`                  | No       | Shares Microsoft Graph throttling cooldowns between processes. See [Sharing throttle cooldowns](#sharing-throttle-cooldowns)      |
| `teamsPacingShare`     | `number`                               | No       | Share of the tenant's Teams request budget this instance uses, above 0 and at most 1. Default `1`. Set `1 / n` when `n` processes back up teams of one tenant. See [Teams pacing](/teams-backup#pacing) |

Construction is synchronous and makes no network requests. It throws `ConfigError` (`ATLAS_CONFIG_INVALID`) when:

- a required field is missing or blank, or the passphrase is shorter than 14 UTF-8 bytes;
- `s3Endpoint` is not a valid URL as described above, or `s3Bucket` is not a valid S3 bucket name;
- `onStorageRequest` is not a function, or `throttleCoordinator` lacks `wait` and `raise` functions;
- `teamsPacingShare` is outside the range above 0 and at most 1.

### Naming

Methods, configuration, options, and result fields are camelCase. Three exceptions:

- Keys of maps that Atlas does not define stay verbatim: `deltaLinks` (keyed by Graph folder ID), `requestsByType` (keyed by request label), and `byService` (keyed by pool name, such as `sharepoint_onedrive`).
- `readMessage().message` keeps the raw Microsoft Graph payload exactly as stored.
- Error properties are snake_case, such as `ThrottledError.retry_after_ms` and `GraphUnavailableError.status_code`. See [Errors](#errors).

## Validation

`atlas.validate()` is optional. Call it after provisioning the tenant bucket to confirm the configuration works before the first run.

```ts
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

`validate(): Promise<void>` runs three checks in order and stops at the first failure. The tenant bucket is `s3Bucket` when set, otherwise `atlas-{tenantId}`.

| Check                                    | Failure                                          | What to do                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| S3 `HeadBucket` on the tenant bucket     | `StorageError`, `ATLAS_STORAGE_FAILURE`          | Check the endpoint, region, credentials, and `s3:ListBucket` access. A missing bucket fails: provision it first               |
| Unwrap `_meta/dek.enc`, if it exists     | `WrongPassphraseError`, `ATLAS_WRONG_PASSPHRASE` | Use the passphrase that created this tenant's backups. In a multi-tenant service, confirm each tenant has its own passphrase  |
| Microsoft Graph token                    | `AuthError`, `ATLAS_AUTH_DENIED`                 | Check the tenant ID, client ID, client secret, and connectivity to Microsoft Entra ID                                         |

- A code names the stage that failed, not necessarily bad credentials. DNS, TLS, and transport failures also fail a stage. The original failure is kept in `cause`.
- When S3 refuses `atlas-{tenantId}` as an invalid bucket name, the first check throws `ConfigError` (`ATLAS_CONFIG_INVALID`) naming the rule. See [Bucket name is not valid](/troubleshooting#bucket-name-is-not-valid).
- The key check makes at most one storage `GET` and opens the key locally with AES-256-GCM. It never creates a key, writes an object, or logs key material. A new tenant with no key passes, and the first backup creates the key.
- `validate()` does not check write permission, Object Lock readiness, or workload-specific Microsoft Graph consent. Use [`checkStorage()`](#checkstorage) for Object Lock and conditional writes. See [Security](/security#kek-derivation-scrypt) for passphrase guidance.

## Logging

The SDK is silent by default. Pass a `logger` to receive its output:

```ts
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

`LogSink` has four methods, `debug`, `info`, `warn`, and `error`, so `pino`, `winston`, an OpenTelemetry exporter, or `console` adapts in a few lines.

- Each line carries `fields` that identify its source, in snake_case to match the log schema: `{ "tenant_id": "<tenant-id>", "operation": "backup" }`. `operation` names the SDK method, so one process serving many tenants can attribute output without matching timestamps.
- `debug` lines reach the sink whatever the `DEBUG` environment variable says. Your logger decides which levels to keep.
- Progress is not logged. Use [progress events](#progress-and-cancellation).

::: tip
Logs are not the record of a run. The typed result is: `summary.warnings`, `summary.folderErrors`, `summary.excludedFolders`, `summary.reactionsNotCaptured`, `integrityFailures`, and the other fields documented per method. Do not parse log text to find out what a run did.
:::

## Storage request events

`onStorageRequest` receives one `StorageRequestEvent` per S3 request the instance sends: duration, connection-pool queueing (`socketWaitMs`), backend time (`networkMs`), SDK retries and backoff, payload size, and outcome. Use `durationMs` for end-to-end latency, because `networkMs` excludes queueing and retry backoff. Events never carry object keys, bucket names, or endpoint hosts.

```ts
const atlas = createAtlasInstance({
  /* ...credentials... */
  onStorageRequest: (event) =>
    storageLatency.record(event.durationMs, {
      command: event.command,
      keyClass: event.keyClass,
    }),
});
```

- Without the option nothing is measured and the storage path is unchanged.
- The callback runs synchronously on the storage path, so it should only record. A throw or a rejected promise is ignored.

See [Storage request events](/reference/storage-request-events) for every field and an OpenTelemetry example.

## Instance lifecycle

An instance holds an S3 client with keep-alive socket pools and a cache of bucket state. Create one per tenant and dispose it when finished:

```ts
const atlas = createAtlasInstance({/* ...config... */});
try {
  await atlas.outlook.backup('user@example.com');
} finally {
  await atlas.dispose();
}
```

With `await using`, disposal happens at the end of the block, also when it throws:

```ts
await using atlas = createAtlasInstance({/* ...config... */});
await atlas.outlook.backup('user@example.com');
```

- `dispose()` closes the socket pools, clears the bucket cache, and unbinds the container. It is idempotent and never throws: a failing step is logged and the remaining steps still run. Do not use the instance afterwards.
- A service that creates an instance per request and never disposes it accumulates socket pools for the life of the process.
- Disposal does not wait for operations in flight. Let them finish or cancel them first, or each one leaves its [owner lease](#concurrent-operations) to expire.
- Bucket caches are per instance. Two instances with different endpoints and same-named buckets do not share answers about bucket existence or Object Lock support.

::: warning
`dispose()` drops the instance's reference to `encryptionPassphrase` and zeroes derived key buffers. JavaScript strings are immutable, so the passphrase string itself stays in memory until garbage collection reclaims it. If that matters, keep the passphrase in a `Buffer` on your side and treat the process boundary as the security boundary.
:::

## Identifiers

Methods accept the same identifiers as the CLI and normalize them the same way.

| Namespace                                     | Accepts                                                                    | Normalization                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `outlook`, `onedrive`, `contacts`, `calendar` | Email or UPN, or Entra object ID                                           | An argument containing `@` is looked up through Microsoft Graph. Anything else is used as given       |
| `sharepoint`                                  | Site URL or hostname, or site ID (`siteGuid,webGuid`, with or without a leading host) | An argument without commas is looked up through Graph. A site ID drops its hostname without a Graph call |
| `teams`                                       | Graph team ID (GUID)                                                       | Trimmed, lowercased, and checked as a GUID. No Graph call                                             |

- A failed lookup throws, so a mistyped address fails instead of addressing an empty scope. Lookups are cached per instance. `resolveUser` and `resolveSite` are available on their own.
- Backups record the resolved email and display name in the snapshot, so later listings show readable owners. Object paths always use the object ID.
- Object IDs and site IDs are lowercased before they become part of an object path, so two spellings of one ID address one tree. Graph item IDs (`fileId`, `itemId`) are case-sensitive and never changed. `fileFilter` compares them case-insensitively.
- Outlook data written by v5 used the SMTP address in its paths and is not reachable under object-ID paths. See [Migrating to v6](/migration/v6).

## Methods

```ts
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
const od = await atlas.onedrive.backup('user@example.com');
await atlas.onedrive.verify('user@example.com', 'od-snap-123');
await atlas.onedrive.checkStatus('user@example.com');
const odStats = await atlas.onedrive.getStats('user@example.com'); // omit the owner for every drive

// SharePoint: site URL or site ID; returns one result per backed-up site
const site = 'https://contoso.sharepoint.com/sites/Example';
const [sp] = await atlas.sharepoint.backup(site);
const tree = await atlas.sharepoint.backup(site, { includeSubsites: true });
await atlas.sharepoint.verify(site, 'sp-snap-123');
const sites = await atlas.sharepoint.listSites();
const spStats = await atlas.sharepoint.getStats(site); // omit the site for every site

// Teams: one team per call, by Graph team ID
const teamRun = await atlas.teams.backup(teamId);
const teamStatus = await atlas.teams.status();

// Tenant scope
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retentionDays: 30 });
const bucket = await atlas.getBucketStats();
const usage = await atlas.getStorageUsage({ breakdown: 'owner' });
```

Method names mirror the CLI: `atlas outlook backup` is `atlas.outlook.backup()`, and `atlas onedrive backup` is `atlas.onedrive.backup()`. The SDK also exposes operations the CLI does not. See [SDK examples](/reference/examples) for production patterns.

Options shared by every long-running method are documented once:

| Topic                         | Applies to                                                                 | Section                                               |
| ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| `onProgress`, `signal`        | `backup`, `restore`, `restoreVersion`, `save`, `verify` of every workload  | [Progress and cancellation](#progress-and-cancellation) |
| `objectLockRequest`           | Every `backup`                                                             | [Object Lock](#object-lock)                            |
| `targetTenant`                | Every `restore`, and Outlook `restoreMailbox`                              | [Cross-tenant restore](#cross-tenant-restore)          |
| `output`                      | Every `save`, and Outlook `saveMailbox`                                    | [Streaming exports](#streaming-exports)                |
| `quarantine(storageKey)`      | Every workload                                                             | [Damaged stored objects](#damaged-stored-objects)      |
| `listSnapshotSummaries`       | Outlook, OneDrive, SharePoint, Contacts, Calendar                          | [Snapshot summaries](#snapshot-summaries)              |

## Outlook

`atlas.outlook` backs up, restores, exports, and inspects mailboxes. Mailbox arguments accept an email address or Entra object ID.

| Method                                | CLI equivalent             | Description                                                                                         |
| ------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `backup(mailboxId, options?)`         | `atlas outlook backup -m`  | Back up one mailbox                                                                                 |
| `verify(snapshotId, options?)`        | `atlas outlook verify`     | Verify the restorable state, attachments and the chain of older snapshots included                  |
| `restore(snapshotId, options?)`       | `atlas outlook restore -s` | Restore from a snapshot                                                                             |
| `restoreMailbox(mailboxId, options?)` | `atlas outlook restore -m` | Restore all snapshots of a mailbox                                                                  |
| `save(snapshotId, options?)`          | `atlas outlook save -s`    | Export a snapshot as a zip of EML files                                                             |
| `saveMailbox(mailboxId, options?)`    | `atlas outlook save -m`    | Export all snapshots of a mailbox as a zip of EML files                                             |
| `listMailboxes()`                     | `atlas outlook list`       | List backed-up mailboxes                                                                            |
| `listSnapshots(mailboxId)`            | _(none)_                   | List a mailbox's snapshot manifests, entries included. Decrypts every manifest                      |
| `listSnapshotSummaries(mailboxId)`    | `atlas outlook list -m`    | List a mailbox's snapshots without entries. See [Snapshot summaries](#snapshot-summaries)           |
| `getSnapshotDetail(snapshotId)`       | _(none)_                   | Read one snapshot manifest with its folders and entries, or `undefined`                             |
| `readMessage(snapshotId, messageRef)` | `atlas outlook read`       | Read one stored message, or `undefined`                                                             |
| `checkMailboxStatus(mailboxId)`       | `atlas outlook status`     | Count pending changes without moving the sync checkpoint. See [Status results](#status-results)     |
| `listAvailableMailboxes(options?)`    | _(discovery)_              | List the tenant's mailboxes through Microsoft Graph                                                 |
| `getMailboxStats(mailboxId)`          | `atlas stats -m`           | Mailbox-level statistics                                                                            |
| `deleteSnapshot(snapshotId)`          | `atlas outlook delete -s`  | Delete the mailbox's newest snapshot                                                                |
| `deleteMailboxData(mailboxId)`        | `atlas outlook delete -m`  | Delete all data of a mailbox                                                                        |
| `purgeTenantData()`                   | `atlas delete --purge`     | Delete the entire tenant bucket, all workloads                                                      |
| `quarantine(storageKey)`              | `atlas outlook quarantine` | Move an unreadable manifest aside                                                                   |

### outlook.backup

Backs up one mailbox. The first run reads every folder; later runs read only what changed since the last sync checkpoint (a Microsoft Graph delta link).

```ts
const result = await atlas.outlook.backup('user@example.com', { excludeJunk: true });

for (const folder of result.summary.excludedFolders) {
  console.log(`${folder.folderPath} not captured: ${folder.reason}`);
}
```

| Option                    | Type          | Description                                                                                                                   |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `forceFull`               | `boolean`     | Ignore saved sync checkpoints and read every folder in full                                                                   |
| `folderFilter`            | `string[]`    | Back up only these folders, by name, path, or Graph well-known name such as `inbox` or `sentitems`                            |
| `excludeJunk`             | `boolean`     | Skip Junk Email and its subfolders. Junk is captured by default                                                               |
| `includeRecoverableItems` | `boolean`     | Also capture the Recoverable Items folders. Off by default. See [Recoverable Items](#recoverable-items)                        |
| `pageSize`                | `number`      | Messages per incremental page requested from Microsoft Graph, 1 to 100. The CLI passes 10                                     |
| `ownerEmail`, `ownerDisplayName` | `string` | Owner labels recorded in the snapshot. Default: the values looked up for an email argument                                  |
| `objectLockRequest`       | `ObjectLockRequest` | Retention for every object written. See [Object Lock](#object-lock)                                                    |
| `hardStopSignal`          | `AbortSignal` | Faster stop than `signal`. See [Outlook escalation](#outlook-escalation)                                                      |
| `onProgress`, `signal`    |               | See [Progress and cancellation](#progress-and-cancellation)                                                                   |

| Result field                        | Description                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `snapshot`                          | `id`, `ownerId`, `ownerEmail`, `ownerDisplayName`, `startedAt`, `completedAt`, `objectCount`, `status`              |
| `manifest`                          | The stored snapshot manifest. See [Snapshot folders](#snapshot-folders) and [Message sender](#message-sender)       |
| `mode`                              | `'full'`, `'incremental'`, or `'initial'`                                                                           |
| `interrupted`, `snapshotStored`     | Whether the run was cancelled, and whether `snapshot` was actually stored                                           |
| `summary.stored`, `deduplicated`, `attachmentsStored`, `processed` | Message counters                                                                     |
| `summary.completedFolderCount`, `totalFolderCount`, `elapsedMs`   | Progress of the run                                                                   |
| `summary.folderErrors`              | One line per failed folder or unmatched `folderFilter` selector                                                     |
| `summary.warnings`                  | One line per notable event, such as a folder whose reactions could not be read                                      |
| `summary.excludedFolders`           | Folders not captured, with `folderPath` and `reason`                                                                |
| `summary.reactionsNotCaptured`      | Messages stored without their reactions and pin                                                                     |
| `summary.unreadableKeys`            | Damaged manifests the run skipped. See [Damaged stored objects](#damaged-stored-objects)                            |
| `summary.interrupted`               | Same as `interrupted`                                                                                               |
| `graphCost`                         | Microsoft Graph requests made. See [Graph cost tracking](#graph-cost-tracking)                                      |

- **Every folder is covered.** The run walks every mail folder at any depth, including Drafts, Outbox, Junk Email, and folders Exchange hides (`MailFolder.isHidden`).
- **Excluded folders say why.** `reason` is `'junk-excluded'`, `'hidden-system-folder'`, `'recoverable-items-not-mail'`, `'recoverable-items-unrecognised'`, or `'deleted-during-listing'` (Microsoft Graph answered 404 for a folder deleted while the run listed folders). The manifest stores the same list as `excludedFolders`, so a stored snapshot shows whether a folder was captured.
- **Folder selectors.** When some `folderFilter` selectors match, the run backs up the matches and lists each unmatched selector in `summary.folderErrors`. When none match, the call rejects with `NotFoundError`. Well-known names match the same folder whatever the mailbox language. See [`atlas outlook backup`](./cli.md#atlas-outlook-backup).
- **Reactions.** A message whose reactions and pin could not be read, because Microsoft Graph returned an error or the read ran out of retries, is still stored and counted in `summary.reactionsNotCaptured`, with one `summary.warnings` line per affected folder. The sync checkpoint still advances, so those properties are read again only when the message changes.
- **Interrupted before any folder.** A run cancelled before it read any folder resolves with `interrupted: true` and `snapshotStored: false`. Its `snapshot` and `manifest` are placeholders that were never stored, `mode` means nothing, and no checkpoint moved. Do not record or look up that snapshot ID. Every other result has `snapshotStored: true`.
- **A run that captured nothing** reports the existing newest snapshot and its count.
- **Counts.** `snapshot.objectCount` counts the messages in the snapshot's chain after recorded removals, the set `verify`, `restore`, and `save` read. `manifest.totalObjects` is a high-water mark: the largest message count any single run of the mailbox stored. It never decreases, and the stale-delta safeguard reads it to tell an unchanged mailbox from one never backed up.

#### Recoverable Items

`includeRecoverableItems` also captures hard-deleted and hold-retained mail from the Exchange dumpster. Incremental backup never reports that mail, so the option is off by default.

```ts
await atlas.outlook.backup('user@example.com', { includeRecoverableItems: true });

const restorable = manifest.entries.filter((entry) => entry.recoverableItems !== true);
await atlas.outlook.restore('snapshot-id', { includeRecoverableItems: true });
```

- `Deletions`, `Purges`, `DiscoveryHolds`, and `SubstrateHolds` are captured. `Versions`, `Calendar Logging`, and `Audits` are listed in `excludedFolders` instead.
- Captured entries carry `recoverableItems: true`. `restore()` and `save()` skip them unless their own `includeRecoverableItems` is set. Restored items go under `Recoverable Items/<subfolder>` in the restore folder, and `save()` uses the same path in the archive.
- The option adds requests only when it is on.

::: warning
Storing purged mail has compliance consequences. See [Recoverable Items and legal hold](/security#recoverable-items-and-legal-hold).
:::

### outlook.verify

Checks that a snapshot can be restored: every message and attachment it and its older snapshots reference is downloaded, decrypted, and checked against its SHA-256.

```ts
const report = await atlas.outlook.verify('snapshot-id', { fast: true });
if (report.failed.length > 0 || report.unverifiable.length > 0) alert(report);
```

| Option                 | Type      | Description                                                                         |
| ---------------------- | --------- | ----------------------------------------------------------------------------------- |
| `fast`                 | `boolean` | Check only that each object exists. Catches deleted objects at almost no bandwidth  |
| `onProgress`, `signal` |           | See [Progress and cancellation](#progress-and-cancellation)                         |

| Result field                  | Description                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `snapshotId`                  | The snapshot checked                                                               |
| `totalChecked`, `passed`      | Objects checked, and objects that passed                                           |
| `failed`                      | Objects that are missing or fail decryption or their checksum                      |
| `unverifiable`                | Objects that never had a stored copy. They count against restorability             |
| `manifestsInChain`            | Snapshots in the chain this check covered                                          |
| `interrupted`                 | Whether the run was cancelled                                                      |

### outlook.restore and restoreMailbox

`restore` writes one snapshot back into a mailbox. `restoreMailbox` restores every snapshot of a mailbox in a date range.

```ts
await atlas.outlook.restore('snapshot-id', { destination: 'Recovered/2026-03 incident' });
```

| Option                    | Type          | Description                                                                                                  |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `folderName`              | `string`      | Restore only this folder and its subfolders, by name or path                                                 |
| `messageRef`              | `string`      | Restore one message by index or ID. `restore` only                                                           |
| `targetMailbox`           | `string`      | Mailbox to restore into. An email address is looked up to its Entra object ID first                          |
| `targetTenant`            | `AtlasTenant` | Restore into another tenant. Requires `targetMailbox`. See [Cross-tenant restore](#cross-tenant-restore)     |
| `destination`             | `string`      | Folder path to restore under, created if missing. Default: a generated `Restore-<timestamp>` folder          |
| `includeRecoverableItems` | `boolean`     | Also restore entries captured from Recoverable Items                                                         |
| `startDate`, `endDate`    | `Date`        | Include snapshots on or after, and on or before, these dates                                                 |
| `onProgress`, `signal`    |               | See [Progress and cancellation](#progress-and-cancellation)                                                  |

Both return a `RestoreResult`:

```ts
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
  objectId: string; // source message id from the snapshot
  targetMessageId: string; // Graph id of the message created in the target mailbox
  targetFolderId: string; // Graph id of the folder it was created in
  attachmentsExpected: { file: number; inline: number };
  attachmentsUploaded: { file: number; inline: number };
  attachmentsFailed: number;
}
```

| Field                  | Description                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `errorCount`, `errors` | Message-level failures, one detail line each. `errorCount` equals `errors.length`                                                   |
| `attachmentErrorCount` | Attachment-level failures, as a count. Details are logged during the restore                                                        |
| `verificationWarnings` | Per-folder warnings, including failures that prevented a count check, and one line per message that received fewer attachments than its snapshot holds |
| `messages`             | One report per message created in the target mailbox, in restore order. IDs and counts only, never names or content                 |
| `restoreFolderName`    | The destination path                                                                                                                |

- **Destination.** `destination` is relative to the top of the target mailbox and uses `/` between levels, as the drive restores do. Each level, and each source folder beneath it, is reused when it exists, matched case-insensitively. The call rejects before writing any message when the path is empty, `/`, has an empty level, or lies inside a well-known folder such as Inbox. See [atlas outlook restore](/reference/cli#atlas-outlook-restore).
- **No deduplication.** Restoring the same snapshot twice into one destination creates every message twice.
- **The chain.** `restore`, `save`, and `verify` read a snapshot together with every older snapshot of the mailbox. `restoreMailbox` and `saveMailbox` read every snapshot in the date range. A message a backup recorded as deleted (in `removed_object_ids`) is left out of every older snapshot in that set. See [Delta sync](/operations/delta-sync#deleted-and-moved-messages-outlook) for which runs record removals.
- **Attachments per message.** `attachmentsExpected` comes from the snapshot: the manifest's attachment list for a Graph JSON entry, or the parts of the stored MIME for a MIME entry. `inline` counts parts embedded in the body (`isInline: true`), `file` counts attachments Outlook lists. A gap between `attachmentsUploaded` and `attachmentsExpected` marks a message that lost attachments. `attachmentsFailed` counts upload errors, which also appear in `errors`. A legacy attachment whose content was never stored is skipped without an error and shows only as that gap.
- **What the counts prove.** The split shows what Atlas restored, from the same MIME parse that drove the upload, not whether the parse classified every part correctly. `attachmentsUploaded` counts what Atlas sent, not what Microsoft Graph stored. To check what landed, read the created message back and compare:

  ```http
  GET /users/{targetMailbox}/messages/{targetMessageId}/attachments?$select=isInline
  ```

- A message whose creation failed has no report. Its failure is in `errors`.

### outlook.save and saveMailbox

Exports a snapshot, or every snapshot of a mailbox, as a zip archive of EML files. A save reads only storage and never writes to Microsoft 365.

```ts
const result = await atlas.outlook.save('snapshot-id', { folderName: 'Inbox', outputPath: 'inbox.zip' });
if (result.integrityFailures.length > 0) console.warn(result.integrityFailures);
```

| Option                    | Type       | Description                                                                          |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `folderName`              | `string`   | Save only this folder and its subfolders, by name or path                            |
| `messageRef`              | `string`   | Save one message by index or ID. `save` only                                         |
| `startDate`, `endDate`    | `Date`     | Include snapshots on or after, and on or before, these dates                         |
| `outputPath`              | `string`   | Output zip path. Default `Restore-<timestamp>.zip`                                   |
| `output`                  | `Writable` | Stream the archive here instead of a file. See [Streaming exports](#streaming-exports) |
| `skipIntegrityCheck`      | `boolean`  | Skip the SHA-256 check of each object. Default `false`                               |
| `includeRecoverableItems` | `boolean`  | Also export entries captured from Recoverable Items                                  |
| `onProgress`, `signal`    |            | See [Progress and cancellation](#progress-and-cancellation)                          |

Both return a `SaveResult`:

```ts
interface SaveResult {
  snapshotId: string;
  savedCount: number;
  attachmentCount: number;
  errorCount: number;
  errors: string[];
  outputPath: string; // empty string when written to a stream
  totalBytes: number;
  integrityFailures: string[];
  graphCost?: OperationCost; // SDK only
  interrupted: boolean;
}
```

#### messageRef rules

| Call                                            | `messageRef`                       | Result                                                                                              |
| ----------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `restoreMailbox`, `saveMailbox`                 | Any value, including `''`          | `ConfigError` (`ATLAS_CONFIG_INVALID`) before the mailbox is looked up, storage is read, or Graph is called. An index counts the messages of one snapshot, and these methods merge every snapshot |
| `restore`, `save`                               | Empty or whitespace only           | `ConfigError` before any Graph call, because it would otherwise read as every message               |
| `restore`, `save`                               | Names no message in the snapshot   | `NotFoundError` (`ATLAS_NOT_FOUND`) before any restore folder or archive is created                 |

A `save` or `saveMailbox` that rejects destroys its `output` stream. A `folderName` that matches nothing rejects `restore` and `save` with `NotFoundError`.

### Listings and snapshot detail

```ts
const snapshot = await atlas.outlook.getSnapshotDetail('snapshot-id');

const inbox = snapshot?.folders?.find((folder) => folder.wellKnownName === 'inbox');
const inboxEntries = snapshot?.entries.filter((entry) => entry.folderId === inbox?.folderId);
```

- **`listMailboxes()`** returns one `MailboxSummary` per backed-up mailbox: `ownerId`, `ownerEmail`, `mailboxPurpose`, `snapshotCount`, `totalObjects`, `totalSizeBytes`, `lastBackupAt`. `totalObjects` counts the messages in the latest snapshot's chain, after recorded removals.
- **`listSnapshots(mailboxId)`** decrypts every manifest. Use [`listSnapshotSummaries`](#snapshot-summaries) unless you need the entries.
- **`readMessage(snapshotId, messageRef)`** returns `raw` (the stored bytes; RFC 5322 MIME when `payloadFormat` is `'mime'`), `attachments`, and for legacy entries `message`, the parsed Microsoft Graph JSON payload.

#### Snapshot folders

Outlook manifests carry `folders`, the folders the run selected, so a client can build a folder pane from a snapshot alone.

- Each folder has `folderId`, `displayName`, `folderPath`, `parentFolderId`, and `totalItemCount`, plus `isHidden`, `isRecoverableItems`, and `wellKnownName` when set.
- `wellKnownName` is `inbox`, `drafts`, `sentitems`, `deleteditems`, `junkemail`, `archive`, `outbox`, `conversationhistory`, `searchfolders`, or `recoverableitemsdeletions`. Display names are localized and users can reuse any name, so match on `wellKnownName`, not `displayName`.
- Microsoft Graph v1.0 has no `wellKnownName` property, so each backup looks up each name with one request, charged to the `outlook` pool. A name the mailbox does not have is not tagged. Other lookup failures are reported in `folderErrors`.
- An incremental manifest lists only the folders its own run selected. Entries carried over from older snapshots can name a folder only an older manifest lists, and manifests from older releases have no `folders`.

#### Message sender

Manifest entries carry `from`, the sender Outlook displays, including delegated and send-as mail. It comes from the incremental page, so it costs no extra request.

```ts
for (const entry of snapshot?.entries ?? []) {
  console.log(entry.from?.address, entry.from?.name); // 'ada@example.com', 'Ada Example'
}
```

`from` is absent on drafts, on system items without a sender, and on entries from older releases. Treat a missing value as an unknown sender. It is personal data, so restrict who can read any listing that includes it.

### Mailbox discovery

`listAvailableMailboxes(options?)` lists the tenant's mailboxes through Microsoft Graph. Pass `{ licensedOnly: true }` to keep only mailboxes with an Exchange Online license.

```ts
const mailboxes = await atlas.outlook.listAvailableMailboxes();
const shared = mailboxes.filter((mb) => mb.mailboxPurpose === 'shared');
const uncovered = mailboxes.filter((mb) => mb.hasInPlaceArchive === true);
const unknown = mailboxes.filter((mb) => mb.hasInPlaceArchive === undefined);
```

Each `TenantMailbox` has `userId`, `mail`, `displayName`, `hasExchangeLicense`, and, when known, `exchangePlanStatus`, `mailboxPurpose`, `purposeLookupError`, `createdAt`, `mailboxSizeBytes`, `itemCount`, and `hasInPlaceArchive`.

#### Shared mailbox identity

`mailboxPurpose` is `'user' | 'linked' | 'shared' | 'room' | 'equipment' | 'others'`, from Graph `mailboxSettings.userPurpose`. `'shared'` marks a shared mailbox. It appears on:

- `TenantMailbox.mailboxPurpose` from `listAvailableMailboxes()`.
- `MailboxSummary.mailboxPurpose` from `listMailboxes()`, taken from the newest manifest that recorded it, so one failed lookup does not blank it.
- `Manifest.mailboxPurpose` from `backup()`, `listSnapshots()`, and `getSnapshotDetail()`, recorded at backup time.

When the lookup fails during discovery, `purposeLookupError` holds the Graph error message. Such a mailbox may still be shared, so do not treat it as an unlicensed user mailbox when deciding what to back up.

#### In-Place Archive coverage

::: warning Archive stores are not backed up
Microsoft Graph cannot read In-Place Archive (Online Archive) mailboxes, so a successful backup of a mailbox with an archive does not cover all its mail. See [In-Place Archive is out of scope](/security#in-place-archive-is-out-of-scope).
:::

`hasInPlaceArchive` is `true`, `false`, or `undefined`. `undefined` means unknown, not "no archive": the value comes from the `Has Archive` column of the mailbox usage report, which needs the optional `Reports.Read.All` permission. Treating `undefined` as covered reports coverage Atlas has not confirmed. No per-mailbox Graph property exposes archive state on v1.0 or beta.

### Deleting Outlook data

| Method                         | Deletes                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `deleteSnapshot(snapshotId)`   | The mailbox's newest snapshot and its sync checkpoint                                                                                |
| `deleteMailboxData(mailboxId)` | Everything of the mailbox: content, snapshots, the sync checkpoint, and the deleted snapshots' Atlas 6 replication records          |
| `purgeTenantData()`            | The entire tenant bucket, every workload. Takes the [tenant lease](#tenant-lease)                                                    |

Each returns `deletedObjects`, `deletedManifests`, `retainedObjects`, `retainedManifests`, `failedObjects`, and `failedManifests`. Retained counts are objects Object Lock kept.

- `deleteSnapshot` accepts only the newest snapshot, because newer snapshots are built on older ones and would lose the messages it recorded. Any other snapshot rejects with `SnapshotNotNewestError` (`ATLAS_SNAPSHOT_NOT_NEWEST`): `err.snapshot_id` names the refused snapshot and `err.newer_snapshot_ids` the ones to delete first. Nothing is deleted.
- While any manifest of the mailbox is unreadable, `deleteSnapshot` rejects with `UnreadableObjectsError` naming the manifest to quarantine.
- Removing the sync checkpoint means the next backup does not resume past the deleted data. See [After a snapshot delete](/operations/delta-sync#after-a-snapshot-delete).

## OneDrive and SharePoint

`atlas.onedrive` works per drive owner (email or Entra object ID) and `atlas.sharepoint` per site (URL or site ID). They expose the same operations.

| Method                                         | CLI equivalent                         | Description                                                                         |
| ---------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `backup(id, options?)`                         | `atlas onedrive backup`, `atlas sharepoint backup` | Back up every drive of an owner, or every library of a site                |
| `verify(id, snapshotId, options?)`             | `verify`                               | Download, decrypt, and checksum every file of a snapshot                            |
| `restore(id, options)`                         | `restore`                              | Restore a snapshot. `options.snapshotId` is required                                |
| `restoreVersion(id, options)`                  | `restore-version`                      | Push stored file versions back into the live drive or library                       |
| `save(id, options)`                            | `save`                                 | Export a snapshot as a zip archive. `options.snapshotId` is required                |
| `listSnapshots(id)`                            | _(none)_                               | Snapshot manifests, entries included. Decrypts every manifest                       |
| `listSnapshotSummaries(id)`                    | `list-snapshots`                       | Snapshots without entries. See [Snapshot summaries](#snapshot-summaries)            |
| `listFileVersions(id, fileRef)`                | `list-versions`                        | Stored versions of one file                                                         |
| `checkStatus(id)`                              | `status`                               | Pending changes per drive or library. See [Status results](#status-results)         |
| `getStats(id?)`                                | `atlas stats`                          | Backup statistics. Omit the argument for every drive or site in the tenant          |
| `deleteSnapshot(id, snapshotId)`               | `delete -s`                            | Delete the newest snapshot                                                          |
| `deleteOwnerData(ownerId)`, `deleteSiteData(siteId)` | `delete`                         | Delete everything of a drive owner or site                                          |
| `quarantine(storageKey)`                       | `quarantine`                           | Move an unreadable manifest or version index aside                                  |
| `sharepoint.listSites()`                       | `atlas sharepoint list-sites`          | Sites the application can read                                                      |
| `sharepoint.resolveSite(urlOrId)`              | _(none)_                               | Look up one site                                                                    |

`listSites()` and `resolveSite()` return `siteId`, `siteUrl`, `displayName`, and `kind`: `site`, or `file_storage_container` for a [SharePoint Embedded container](/sharepoint-backup#sharepoint-embedded-containers), which Atlas cannot back up. `listSites()` returns containers rather than leaving them out, so filter on `kind`.

See [OneDrive backup](/onedrive-backup) and [SharePoint backup](/sharepoint-backup) for workload guides.

### Drive backup

```ts
const [sp] = await atlas.sharepoint.backup(site);
if (!sp.snapshot && sp.summary.noSnapshotReason === 'no_content') {
  // Nothing to protect yet. Do not report this site as backed up.
}
```

| Option                  | On         | Description                                                                              |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `forceFull`             | both       | Ignore saved sync checkpoints and read every drive or library in full                    |
| `folderScope`           | OneDrive   | Back up one folder of the drive instead of the whole drive                               |
| `ownerEmail`, `ownerDisplayName` | OneDrive | Owner labels recorded in the snapshot                                          |
| `siteUrl`, `siteDisplayName` | SharePoint | Site labels recorded in the snapshot                                               |
| `includeSubsites`       | SharePoint | Also back up every subsite. The call returns one result per site                         |
| `objectLockRequest`     | both       | See [Object Lock](#object-lock)                                                          |
| `onProgress`, `signal`  | both       | See [Progress and cancellation](#progress-and-cancellation)                              |

OneDrive returns one result; SharePoint returns an array with one result per site.

| Result field                         | Description                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `ownerId` / `siteId`                 | The owner or site backed up                                                                       |
| `snapshot`                           | The snapshot manifest, or `undefined` when none was written                                       |
| `interrupted`                        | Whether the run was cancelled                                                                     |
| `summary.drivesScanned` / `librariesScanned` | Drives or libraries read                                                                  |
| `summary.filesChanged`, `filesStored`, `filesDeduplicated`, `deletedItems` | File counters                                               |
| `summary.versionsStored`, `versionsUnavailable` | Historical versions stored, and versions Microsoft 365 no longer holds                 |
| `summary.snapshotCreated`, `noSnapshotReason` | Whether a snapshot was written, and why not                                              |
| `summary.cursorUpdated`              | Whether the run saved its sync checkpoint                                                         |
| `summary.errors`, `warnings`, `healthy` | Failures, notices, and whether the run is healthy                                              |
| `summary.unreadableKeys`             | Damaged manifests the run skipped                                                                 |

- **`noSnapshotReason`** is set only when a completed run created no snapshot: `'no_changes'` when content exists and nothing changed, `'no_content'` when the drive or site holds nothing to protect. It is absent when a snapshot was created. Interrupted or unhealthy runs report `interrupted` and `errors` instead.
- **`cursorUpdated`** is `true` when the run saved its sync checkpoint, the position the next run resumes from. A completed run saves it whether or not it created a snapshot, and so does a run that recorded failed files or was cancelled after its scan started; in that case only the drives and libraries it finished advance. It is `false` when the run was cancelled before its scan started, for example with an already-aborted signal or while the drive, library, or subsite list was loading, including a throttle wait on that list. Nothing was read or stored, and the next run resumes from the previous checkpoint.
- **A deleted or quarantined snapshot.** A backup whose saved checkpoint names a snapshot that no longer exists reads in full and says why in `summary.warnings`. Until that run, `checkStatus` reports `isUpToDate: false`.
- **Subsites.** With `includeSubsites: true`, a subsite listing that fails after retries adds its error to the root result's `summary.errors` and sets its `healthy` to `false`. A busy subsite is handled as described in [Concurrent operations](#concurrent-operations).

### Drive verify

```ts
const report = await atlas.onedrive.verify('user@example.com', 'od-snap-123');
```

Options: `fast` (existence only), `onProgress`, `signal`. The result has `snapshotId`, `totalChecked`, `passed`, `failedFileIds`, `indexIssues` (damaged version index objects), `interrupted`, and `unreadableKeys`.

### Drive restore

```ts
const snapshotId = 'od-snap-123';
await atlas.onedrive.restore('owner-id', { snapshotId }); // /Restore-2026-08-27T10-15-30/...
await atlas.onedrive.restore('owner-id', { snapshotId, destination: '/DR-drill' });
await atlas.onedrive.restore('owner-id', { snapshotId, inPlace: true });
```

| Option                          | Type                                | Description                                                                                        |
| ------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `snapshotId`                    | `string`                            | Required. The snapshot to restore                                                                  |
| `fileFilter`                    | `string[]`                          | Restore only these files, by Graph item ID, rooted path, or file name                              |
| `destination`                   | `string`                            | Folder to restore under. Default: a generated `/Restore-<timestamp>` root                          |
| `inPlace`                       | `boolean`                           | Write back to the original paths                                                                   |
| `renameTo`                      | `string`                            | New name for the restored file. Only when the restore resolves to exactly one file                 |
| `conflictBehavior`              | `'replace' \| 'rename' \| 'fail'`   | What to do when a file exists at the target. Default `'rename'`                                    |
| `targetOwnerId` / `targetSiteId`| `string`                            | Restore into another owner or site. Required with `targetTenant`                                   |
| `targetTenant`                  | `AtlasTenant`                       | See [Cross-tenant restore](#cross-tenant-restore)                                                  |
| `onProgress`, `signal`          |                                     | See [Progress and cancellation](#progress-and-cancellation)                                        |

The result has `snapshotId`, `filesRestored`, `foldersCreated`, `filesSkipped`, `errors`, `interrupted`, `unreadableKeys`, and `unmatchedFileFilters`.

- By default nothing existing is overwritten: files go under a new root with `'rename'` on conflict.
- `restore` and `save` require an options object with `snapshotId`. TypeScript enforces it. A JavaScript caller that omits it gets a `TypeError` naming the method. `verify` takes its options optionally.
- When some `fileFilter` values match, the run goes ahead and lists each unmatched value in `unmatchedFileFilters`. When none match, the call rejects with `NotFoundError`.

### restoreVersion

`restoreVersion()` writes stored file versions back into the live drive or library, either one exact version or every file as it was at a point in time.

```ts
// One exact version. List versions first to see what exists.
const versions = await atlas.onedrive.listFileVersions('owner-id', '/Documents/report.docx');
// The SDK does not guarantee an order, so pick the newest stored version explicitly
const previous = [...versions].sort((a, b) =>
  (b.lastModifiedAt ?? '').localeCompare(a.lastModifiedAt ?? ''),
)[0];
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

if (result.filesSkipped > 0) {
  for (const reason of result.errors) console.warn(reason);
}
```

| Option                 | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `fileRef`              | Graph item ID, rooted path, or bare file name. Required with `versionId`         |
| `versionId`            | Exact stored version, from `listFileVersions()`                                  |
| `before`               | `Date`. Restores each file's newest version at or before this instant            |
| `pathPrefix`           | Limits a `before` rollback to one folder and its contents                        |
| `placement`            | `'copy'` (default) writes a sibling file. `'in-place'` uploads over the original |
| `onProgress`, `signal` | See [Progress and cancellation](#progress-and-cancellation)                      |

Pass either `fileRef` with `versionId`, or `before`. The result has `filesRestored`, `filesSkipped`, `errors`, `interrupted`, the `placement` used, and `restored`, an array of `{ fileId, versionId, lastModifiedAt, sizeBytes, restoredTo }`.

- A file with no version at or before the cutoff appears in `errors` and counts as skipped, so a partial rollback is visible.
- Neither placement destroys data. `'copy'` never touches the live file. `'in-place'` uploads a new version, and Microsoft 365 keeps the replaced content in the file's own version history.
- Restored files carry the modification time of the version, not the time of the restore.
- Atlas uploads its own checksum-verified bytes rather than asking Microsoft 365 to restore a version, because Microsoft 365 only restores versions it still holds and those cannot be checked against the snapshot. See [the CLI reference](/reference/cli#atlas-onedrive).

### Drive save

```ts
await atlas.sharepoint.save(site, { snapshotId: 'sp-snap-123', outputPath: 'site.zip' });
```

Options: `snapshotId` (required), `fileFilter`, `outputPath`, `output` (see [Streaming exports](#streaming-exports)), `skipIntegrityCheck`, `onProgress`, `signal`. The result has `snapshotId`, `filesSaved`, `filesSkipped`, `errors`, `integrityFailures`, `outputPath`, `totalBytes`, `interrupted`, `unreadableKeys`, and `unmatchedFileFilters`. `fileFilter` behaves as on restore.

### Drive listings and item metadata

There is no `getSnapshotDetail` for drives. Find a snapshot with `listSnapshots` and filter by `snapshotId`:

```ts
const snapshot = (await atlas.onedrive.listSnapshots('owner-id')).find(
  (manifest) => manifest.snapshotId === 'od-snap-123',
);

for (const entry of snapshot?.entries ?? []) {
  entry.fileSystemInfo?.createdAt; // original client timestamp, reapplied on restore
  entry.createdBy?.displayName; // author, recorded for audit only
  entry.lastModifiedBy?.email;
}
```

- `fileSystemInfo` holds the client-reported timestamps from Microsoft 365. A restore reapplies them. `lastModifiedAt` stays the service-side value, which shows the restore time after a restore.
- Authors and version authors are captured but not reapplied. Sharing permissions are not captured. See [What a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).
- These fields are absent on snapshots written before 4.1.0.

### Deleting drive data

| Method                                                          | Deletes                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `onedrive.deleteSnapshot(ownerId, snapshotId)`, `sharepoint.deleteSnapshot(siteId, snapshotId)` | The newest snapshot of the owner or site, and its sync checkpoint |
| `onedrive.deleteOwnerData(ownerId)`, `sharepoint.deleteSiteData(siteId)` | Everything of the owner or site                   |

- `deleteSnapshot` accepts only the newest snapshot, because a drive snapshot stores only its own run's changes and newer snapshots are built on it. Any other rejects with `SnapshotNotNewestError` (`ATLAS_SNAPSHOT_NOT_NEWEST`), naming `err.snapshot_id` and `err.newer_snapshot_ids` to delete first. Nothing is deleted.
- While a manifest of the owner or site is unreadable, the order cannot be checked and the call rejects with `UnreadableObjectsError` naming the manifest to quarantine.
- The check decrypts manifests, so `deleteSnapshot` needs the tenant's data key. `deleteOwnerData` and `deleteSiteData` do not.
- After `deleteSnapshot`, the next `backup` reads every drive or library in full and captures again what the deleted snapshot held. The run's version index is kept, so `listFileVersions` and `restoreVersion` still offer the versions it recorded.

## Teams

`atlas.teams` backs up channel messages, one team per call, identified by its Microsoft Graph team ID. Restore is not available. `save` exports a snapshot as a zip archive and makes no Graph calls.

| Method                                 | CLI equivalent                                 | Description                                                                         |
| -------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `listTeams()`                          | `atlas teams list-teams`                       | Teams the application can read, as Microsoft Graph returns them                     |
| `backup(teamId, options?)`             | `atlas teams backup --team <id>`               | Back up one team's channels                                                         |
| `verify(teamId, snapshotId, options?)` | `atlas teams verify --team <id> -s <snapshot>` | Decrypt each channel shard and every blob it references, and compare its SHA-256    |
| `save(teamId, options)`                | `atlas teams save --team <id> -s <snapshot>`   | Export one snapshot as a zip archive                                                |
| `listSnapshots(teamId)`                | `atlas teams list-snapshots --team <id>`       | `{ indexes, unreadableKeys, unsupportedKeys }` for one team                         |
| `status()`                             | `atlas teams status`                           | Newest snapshot of each team in the tenant                                          |
| `delete(teamId, snapshotId?)`          | `atlas teams delete --team <id>`               | Delete all data of a team, or only one snapshot's index                             |
| `quarantine(storageKey)`               | `atlas teams quarantine --key <key>`           | Move an unreadable snapshot index aside                                             |

```ts
const run = await atlas.teams.backup(teamId);
if (!run.summary.healthy) {
  // A channel failed, a failed root is still listed, or the run was interrupted. The other channels still ran.
}
if (run.snapshot) {
  await atlas.teams.verify(teamId, run.snapshot.snapshotId);
}
```

| Backup option          | Description                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `channelId`            | Back up only this channel                                                           |
| `concurrency`          | Channels backed up at once, 1 to 16. Default 4                                      |
| `forceFull`            | Read every channel in full                                                          |
| `teamDisplayName`      | Team label recorded in the snapshot                                                 |
| `objectLockRequest`    | See [Object Lock](#object-lock)                                                     |
| `onProgress`, `signal` | See [Progress and cancellation](#progress-and-cancellation)                         |

The instance `tenantId` must be a GUID, not a domain, or `backup` throws `ConfigError`.

| Result field                    | Description                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `teamId`, `snapshot`, `interrupted` | The team, its new snapshot index or `undefined`, and whether the run was cancelled                                            |
| `graphCost`                     | Microsoft Graph requests, counted in the `teams` pool                                                                             |
| `summary.channelsScanned`, `channelsFullRead` | Channels read, and channels read in full                                                                            |
| `summary.threadsChanged`, `messagesStored`, `messagesDeduplicated`, `hostedContentStored`, `threadsDeleted` | Run counters                                          |
| `summary.cursorUpdated`, `snapshotCreated`, `noSnapshotReason` | As on [drive backup](#drive-backup)                                                                |
| `summary.errors`, `warnings`, `healthy` | `healthy` reflects channel failures only                                                                                  |
| `summary.elapsedMs`             | Run time                                                                                                                          |
| `summary.channels`              | One entry per channel: `channelId`, `outcome`, `readMode`, `rootsApplied`, `resumedFromCheckpoint`, `elapsedMs`                   |
| `summary.requests`              | `messages` and `default`, each with `requests`, `throttled`, and `achievedRps`                                                    |
| `summary.unreadableKeys`        | Snapshot indexes newer than the run's baseline that could not be read. The run still finishes                                     |
| `summary.repairedShardKeys`     | Unreadable channel shards a `forceFull` run rewrote at the same key. See [Unreadable channel shards](../teams-backup.md#unreadable-channel-shards) |

- `outcome` is `completed`, `incomplete`, `interrupted`, `failed`, or `not_started`. `readMode` is `full` or `delta`.
- Each `processing` progress event of a Teams backup carries `etaMs`, the estimated time left.
- `verify` takes `fast` to check existence only. Its result has `snapshotId`, `totalChecked`, `passed`, `failedStorageKeys`, `missingStorageKeys`, `unsupportedStorageKeys`, and `interrupted`.
- `save` takes `snapshotId` (required), `channelId` to export one channel, and `outputPath` or `output`. Its result has `channelsSaved`, `messagesSaved`, `imagesInlined`, `hostedFiles`, `hostedMissing` (hosted contents the backup never captured), `errors`, `outputPath`, `totalBytes`, and `interrupted`.
- `status()` returns per team `teamId`, `teamDisplayName`, `lastBackupAt`, `lastSnapshotId`, `totalChannels`, `failedRootCount` and `pendingRecheckCount` (the `Failed roots` and `Pending rechecks` columns of `atlas teams status`), and the damaged-object lists described in [Damaged stored objects](#damaged-stored-objects).

See [Teams backup](../teams-backup.md#backup) for what each counter means and [Pacing](../teams-backup.md#pacing) for running many teams.

## Contacts

`atlas.contacts` backs up, restores, verifies, and deletes one mailbox's personal contacts. Mailbox arguments accept an email address or Entra object ID.

| Method                                  | CLI equivalent                | Description                                                               |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `backup(mailbox, options?)`             | `atlas contacts backup -m`    | Back up changed contacts                                                  |
| `restore(mailbox, options)`             | `atlas contacts restore -m`   | Restore a snapshot without overwriting                                    |
| `verify(mailbox, snapshotId, options?)` | `atlas contacts verify -m`    | Verify a snapshot                                                         |
| `listSnapshots(mailbox)`                | `atlas contacts list -m`      | Snapshots with entries. Decrypts every manifest                           |
| `listSnapshotSummaries(mailbox)`        | `atlas contacts list -m`      | Snapshots without entries                                                 |
| `deleteMailboxData(mailbox)`            | `atlas contacts delete -m`    | Delete all contacts data of a mailbox                                     |
| `deleteSnapshot(mailbox, snapshotId)`   | `atlas contacts delete -m -s` | Delete one snapshot and the mailbox's sync checkpoint                     |
| `quarantine(storageKey)`                | `atlas contacts quarantine`   | Move an unreadable manifest aside                                         |

```ts
const run = await atlas.contacts.backup('user@example.com');
await atlas.contacts.restore('user@example.com', { snapshotId: run.snapshot!.snapshotId });
```

- `backup` options: `forceFull`, `objectLockRequest`, `onProgress`, `signal`. The summary has `foldersScanned`, `contactsChanged`, `contactsRemoved`, `objectsStored`, `snapshotCreated`, `noSnapshotReason`, `errors`, `healthy`, and `unreadableKeys`.
- `restore` options: `snapshotId` (required), `targetMailboxId` to restore into another mailbox, `targetTenant`, `onProgress`, `signal`. The result has `snapshotId`, `contactsRestored`, `contactsSkipped`, `foldersCreated`, `errors`, and `interrupted`. A contact the target already holds is skipped.
- `verify` takes `fast` and returns the same fields as [`outlook.verify`](#outlook-verify).

See [Contacts backup](/contacts-backup) for the storage layout and restore behaviour.

## Calendar

`atlas.calendar` backs up, restores, verifies, and deletes one mailbox's Outlook calendars, including recurring series and file attachments on events. Mailbox arguments accept an email address or Entra object ID.

| Method                                  | CLI equivalent                | Description                                                               |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `backup(mailbox, options?)`             | `atlas calendar backup -m`    | Back up changed calendars and events                                      |
| `restore(mailbox, options)`             | `atlas calendar restore -m`   | Restore a snapshot without overwriting                                    |
| `verify(mailbox, snapshotId, options?)` | `atlas calendar verify -m`    | Verify a snapshot                                                         |
| `listSnapshots(mailbox)`                | `atlas calendar list -m`      | Snapshots with entries. Decrypts every manifest                           |
| `listSnapshotSummaries(mailbox)`        | `atlas calendar list -m`      | Snapshots without entries                                                 |
| `deleteMailboxData(mailbox)`            | `atlas calendar delete -m`    | Delete all calendar data of a mailbox                                     |
| `deleteSnapshot(mailbox, snapshotId)`   | `atlas calendar delete -m -s` | Delete one snapshot and the mailbox's sync checkpoint                     |
| `quarantine(storageKey)`                | `atlas calendar quarantine`   | Move an unreadable manifest aside                                         |

```ts
const run = await atlas.calendar.backup('user@example.com');
if (!run.summary.healthy) console.warn(run.summary.warnings);
```

- `backup` options: `forceFull`, `objectLockRequest`, `onProgress`, `signal`.
- The backup `summary` has `calendarsScanned`, `calendarsSkipped` (read-only calendars such as Birthdays), `eventsChanged`, `eventsRemoved`, `objectsStored`, `snapshotCreated`, `noSnapshotReason` when no snapshot was written, `warnings` (for example item and reference attachments that are not captured), `attachmentsSkipped` (attachments the stored events carry but the backup does not capture), `errors`, `healthy`, and `unreadableKeys`. `healthy` is `false` when any event failed or `attachmentsSkipped` is above zero.
- `restore` options: `snapshotId` (required), `targetMailboxId`, `targetTenant`, `onProgress`, `signal`. The result has `snapshotId`, `eventsRestored`, `eventsSkipped`, `calendarsCreated`, `errors`, and `interrupted`. An event the target already holds is skipped.
- Restore never sends meeting invitations: restored events carry no attendees, and the attendee list is written into the event body. See [why attendees are not re-invited](/calendar-backup#why-attendees-are-not-re-invited).

See [Calendar backup](/calendar-backup) for the storage layout and restore behaviour.

## Tenant-wide methods

| Method                          | Description                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `validate()`                    | Checks storage, the passphrase, and Microsoft Graph access. See [Validation](#validation)       |
| `checkStorage(request?)`        | Reports what the bucket supports. See [checkStorage](#checkstorage)                             |
| `getBucketStats()`              | Logical totals across the tenant: mailboxes, snapshots, messages, and sizes                     |
| `getStorageUsage(options?)`     | Bytes the bucket physically holds. See [Storage usage](#storage-usage)                          |
| `resolveUser(email)`            | Looks up an address's Entra object ID through Microsoft Graph                                   |
| `listUsers()`                   | The tenant's identity registry, or `undefined` when none exists yet                             |
| `rewrapDataKey(newPassphrase?)` | Re-wraps the tenant data key. See [Key re-wrap](#key-re-wrap)                                   |
| `keys`                          | Re-wraps and purges key wrappers across tenants. See [Re-wrapping several tenants](#re-wrapping-several-tenants) |
| `dispose()`                     | Releases the instance. See [Instance lifecycle](#instance-lifecycle)                            |

### checkStorage

```ts
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retentionDays: 30 });
if (check.conditionalWrites.support !== 'supported') {
  // Schedule one operation per owner yourself. See Concurrent operations.
}
```

The result has `bucket`, `reachable`, `versioningEnabled`, `objectLockEnabled`, `modeSupported`, `defaultRetention` (`{ mode, days?, years? }`), the request echoed as `requestedMode` and `requestedRetentionDays`, the `resolvedRetainUntil` it would apply, and `conditionalWrites`. `conditionalWrites` is always present: `{ support: 'supported' | 'ignored' | 'not_probed', detail?: string }`, whether the backend refuses a create-only write and a stale compare-and-swap. The probe writes and removes one object under `_meta/storage-check/`, so it needs write access.

### Storage usage

`getStorageUsage(options?)` lists the tenant bucket and reports the bytes it physically holds. `getBucketStats()` and the workload `getStats()` methods report logical sizes instead. See [Storage usage](/operations/storage-usage) for categories, request cost, and required permissions.

```ts
const usage = await atlas.getStorageUsage();
console.log(usage.storedBytes, usage.totals.noncurrent.bytes, usage.logicalBytesReferenced);

// Measured in slices of 1,000 list requests
let part = await atlas.getStorageUsage({ maxListRequests: 1000 });
while (!part.complete) {
  part = await atlas.getStorageUsage({
    maxListRequests: 1000,
    continuationToken: part.continuationToken,
  });
}
```

| Option              | Type                    | Description                                                                                            |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `breakdown`         | `'workload' \| 'owner'` | `owner` adds `byOwner`, one row per mailbox, OneDrive owner, or site. Workload rows are always present |
| `maxListRequests`   | `number`                | Stop after this many S3 requests and return a continuation token                                       |
| `continuationToken` | `string`                | Resume a run that stopped early                                                                        |
| `signal`            | `AbortSignal`           | Stop at the next page boundary and return a continuation token instead of throwing                     |

| Field                                         | Description                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `totals`                                      | `current`, `noncurrent`, `staging`, and `incompleteUploads` as `{ objects, bytes }`, plus `deleteMarkers`      |
| `byWorkload`                                  | The same breakdown per `outlook`, `onedrive`, `sharepoint`, `teams`, `meta`, and `other`. Rows sum to `totals` |
| `byOwner`                                     | With `breakdown: 'owner'`, rows of `{ workload, ownerId, totals }`, largest first                              |
| `storedBytes`                                 | Current plus noncurrent plus incomplete upload parts                                                           |
| `logicalBytesReferenced`                      | Logical bytes all manifests reference. Set only on a complete run whose manifests could all be read            |
| `logicalBytesByWorkload`                      | The same, per workload                                                                                         |
| `versionsVisible`, `incompleteUploadsVisible` | `false` when the credentials cannot list versions or multipart uploads. Those figures are then incomplete      |
| `complete`, `continuationToken`               | Whether the run finished, and the token that resumes it when it did not                                        |
| `listRequests`                                | S3 requests made so far, across resumed calls                                                                  |
| `target`, `startedAt`, `measuredAt`           | `primary` or the target's `targetId`. When the first call started, and when this call finished                 |

A run that stops early returns rather than throws, so a scheduler can store the token and continue on its next tick. A run that fails on an S3 error throws, and the error carries a token for the last page counted:

```ts
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

Invalid options, and a token issued for a different tenant, target, or breakdown, throw `ConfigError` before any request. Such an error carries no token.

### Key re-wrap

`rewrapDataKey(newPassphrase?)` re-wraps the tenant's data key under a new passphrase, or under the configured one with current key derivation (KDF) parameters. Use the second form to move a tenant created with weaker scrypt parameters to current ones.

```ts
const result = await atlas.rewrapDataKey(newPassphrase);
console.log(result.passphraseChanged, result.previousKdfId, result.kdfId);
```

| Field               | Type      | Description                                                      |
| ------------------- | --------- | ---------------------------------------------------------------- |
| `tenantId`          | `string`  | Tenant whose key was re-wrapped                                  |
| `passphraseChanged` | `boolean` | `false` when the call re-wrapped under the configured passphrase |
| `previousKdfId`     | `number`  | KDF the wrapper used before the call                             |
| `kdfId`             | `number`  | KDF the new wrapper uses                                         |

::: warning This rotates the wrapper, not the key
The data key does not change, so nothing is re-encrypted and every snapshot stays readable. An attacker who already holds the data key or plaintext is not affected. Use re-wrap after a leaked passphrase, not after a compromised bucket.
:::

- **Old wrappers stay readable.** Buckets are versioned, so the replaced wrapper stays as a noncurrent version. Someone with the old passphrase and permission to read object versions can still unwrap the data key from it. Delete it with `keys.purgeOldWrappers`, or revoke the leaked reader's `s3:GetObjectVersion` permission.
- **Checked before and after.** A wrong current passphrase is rejected before anything is written. After the write the new wrapper is read back and unwrapped, so a resolved call means the tenant opens with the new passphrase.
- **When the check fails,** the previous wrapper is restored and the call throws `DekRewrapVerificationError`. If restoring it also fails, the call throws `DekRewrapRollbackError` and the stored wrapper is in an unknown state. Neither class is exported. Both extend `StorageError`, so branch on `ATLAS_STORAGE_FAILURE` and inspect the bucket before retrying.
- **Exclusive.** The call takes the [tenant lease](#tenant-lease), so it rejects with `OwnerBusyError` and changes nothing while any owner of the tenant is busy, and owner operations are refused until it returns.
- **Update your configuration afterwards.** Nothing reads the new passphrase until you do, and an instance still built with the old one fails its next operation.

### Re-wrapping several tenants

`rewrapDataKey` covers this instance's tenant only. When several tenants share one passphrase, a change must cover all of them before any instance is built with the new value, or every tenant left behind fails with `WrongPassphraseError`. `atlas.keys` does this across tenants, using this instance's S3 settings.

```ts
const report = await atlas.keys.rewrapTenantKeys({
  tenantIds: ['<tenant-id-1>', '<tenant-id-2>'],
  newPassphrase,
});

if (!report.complete) {
  // Keep the old passphrase. Rerun later: tenants already re-wrapped are skipped.
}
```

| Method                            | Description                                                                |
| --------------------------------- | -------------------------------------------------------------------------- |
| `keys.rewrapTenantKeys(options?)` | Re-wraps each tenant still under the current passphrase. Safe to repeat    |
| `keys.purgeOldWrappers(options?)` | Deletes noncurrent `_meta/dek.enc` versions that hold the current data key |

| Option                | Applies to         | Default                   | Description                                                                   |
| --------------------- | ------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| `tenantIds`           | both               | this instance's tenant    | Every tenant whose key shares the passphrase. Duplicates count once           |
| `currentPassphrase`   | `rewrapTenantKeys` | the configured passphrase | The passphrase the stored keys open with now                                  |
| `newPassphrase`       | `rewrapTenantKeys` | the configured passphrase | The passphrase to wrap under. Equal to the current one for a KDF-only refresh |
| `previousPassphrases` | `purgeOldWrappers` | `[]`                      | Passphrases an old version may be wrapped under                               |

**`rewrapTenantKeys`** resolves with `outcomes` (one per tenant, in request order), `passphraseChanged`, and `complete`.

| Outcome `status`             | Meaning                                          |
| ---------------------------- | ------------------------------------------------ |
| `rewrapped`                  | Done. Carries `previousKdfId` and `kdfId`        |
| `already_rewrapped`          | Already under the new passphrase                 |
| `no_key`                     | The tenant has no data key yet                   |
| `unopenable`                 | The current passphrase does not open the key     |
| `busy`, `failed`             | Not done. Carries `detail`                       |

`complete` is `true` only when every tenant is `rewrapped`, `already_rewrapped`, or `no_key`. Only then may the old passphrase be retired. One tenant failing does not stop the others, and the promise resolves rather than rejects for per-tenant results. It rejects with `ConfigError` before touching any tenant when `newPassphrase` is shorter than 14 UTF-8 bytes. Each tenant runs under its tenant lease.

**`purgeOldWrappers`** resolves with `outcomes` and `complete`. Each tenant's `status` is `purged`, `versions_left`, `no_key`, `current_unopenable`, `busy`, or `failed`, and lists its noncurrent `versions`, each `deleted`, `retained`, `unverified`, `different_key`, or `failed`.

- The configured passphrase must open a tenant's current wrapper, or nothing of that tenant is deleted.
- Only versions that unwrap to the current data key are deleted. Object Lock governance retention is never bypassed.
- Each tenant runs under its tenant lease, taken as `rewrap`. See [Old wrapper versions](/security#old-wrapper-versions).

The SDK never changes its own configuration. After a complete rotation, build new instances with the new passphrase.

## Snapshot summaries

```ts
const snapshots = await atlas.onedrive.listSnapshotSummaries('user@example.com');
const newest = snapshots[0]; // { snapshotId, createdAt, manifestKey, entryCount, totalFiles, totalSizeBytes, ... }
```

`listSnapshotSummaries` on `atlas.outlook`, `atlas.onedrive`, `atlas.sharepoint`, `atlas.contacts`, and `atlas.calendar` returns an owner's snapshots newest first from its [snapshot summary index](/operations/storage-layout#snapshot-summary-index): one storage listing and one small read, whatever the number of snapshots. `listSnapshots` returns whole manifests and decrypts every one, so use it only when you need the entries.

| Field                            | On                   | Meaning                                                           |
| -------------------------------- | -------------------- | ----------------------------------------------------------------- |
| `snapshotId`, `createdAt`        | all                  | Snapshot identity and time                                        |
| `manifestKey`                    | all                  | Object path of the snapshot's manifest                            |
| `entryCount`                     | all                  | Entries in this snapshot's own manifest, which holds one run's changes |
| `totalSizeBytes`                 | all                  | The manifest's `totalSizeBytes`                                   |
| `ownerId` / `siteId` / `mailboxId` | all                | The owner                                                         |
| `objectCount`                    | Outlook              | Messages in the snapshot's chain, after recorded removals         |
| `totalObjects`, `removedCount`   | Outlook              | Message high-water mark, and message IDs the run recorded removed |
| `objectLock`                     | Outlook              | Effective Object Lock mode and `retainUntil`, when set            |
| `mailboxPurpose`, `aggregates`   | Outlook              | Mailbox purpose, and per-folder totals when recorded              |
| `totalFiles`                     | OneDrive, SharePoint | The manifest's `totalFiles`                                       |
| `totalContacts` / `totalEvents`  | Contacts / Calendar  | Items in the snapshot                                             |
| `ownerEmail`, `ownerDisplayName` | Outlook, OneDrive    | Owner labels recorded at backup time                              |
| `siteUrl`, `siteDisplayName`     | SharePoint           | Site labels recorded at backup time                               |

A summary row stands in for its manifest without decrypting it, so a manifest damaged after its row was written is still listed. A manifest with no row that cannot be decrypted is reported through the partial result described in [Damaged stored objects](#damaged-stored-objects). Run `verify` to check manifests at rest.

## Status results

`checkMailboxStatus`, `onedrive.checkStatus`, and `sharepoint.checkStatus` ask Microsoft Graph for changes since the last backup without moving the saved sync checkpoint.

```ts
const status = await atlas.onedrive.checkStatus('user@example.com');
if (!status.isUpToDate) scheduleBackup(status.ownerId, status.totalPendingChanges);
```

Each result has `lastBackupAt`, `lastSnapshotId`, `isUpToDate`, `totalPendingChanges`, and one row per folder (`folders`, Outlook), drive (`drives`), or library (`libraries`) with `hasBackup`, `isUpToDate`, and its pending counts.

| Field              | On                                  | Meaning                                                                                                      |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pendingNew`, `pendingRemoved` | Each Outlook folder     | Messages added and removed since the last backup                                                             |
| `pendingChanges`   | Each drive or library               | Changed files. Counts files only, as backup does, and is exact                                               |
| `pendingCapped`    | Each folder, and the mailbox result | The check stopped at 5 pages of 50 messages, so the pending counts are a lower bound                         |
| `peekError`        | Each folder, drive, or library      | `<ErrorClass>: <message>` when the check failed for another reason. The row and the result are not up to date |
| `failedItems`      | Each drive or library               | Files of that drive in the list of failed files                                                              |
| `totalFailedItems` | OneDrive and SharePoint results     | Every failed file. Any makes `isUpToDate` false                                                              |
| `unreadableKeys`   | Every status result                 | Damaged snapshot manifests. `lastSnapshotId` is then the newest readable snapshot                            |
| `graphCost`        | Outlook                             | Microsoft Graph requests made                                                                                |

A permission problem is never reported as pending changes:

| Situation                                                                   | Result                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Microsoft Graph answers `401`, or a `403` for a missing grant               | Rejects with `AuthError` (`ATLAS_AUTH_DENIED`)                        |
| A drive or library refused with a `403` not attributed to a missing grant   | That row's `peekError` names `GraphAccessRefusedError`                |
| A SharePoint site refused that way                                          | Rejects with `GraphAccessRefusedError` (`ATLAS_ACCESS_REFUSED`)       |
| An unlicensed mailbox                                                       | `checkMailboxStatus` rejects with `MailboxNotLicensedError`           |

## Progress and cancellation

Every `backup`, `restore`, `save`, and `verify` of Outlook, OneDrive, and SharePoint accepts `onProgress` and `signal`, and so do `restoreVersion`, Outlook `restoreMailbox` and `saveMailbox`, Teams `backup`, `verify`, and `save`, and Calendar and Contacts `backup`, `restore`, and `verify`.

| Option       | Type                                      | Description                                                                                         |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `onProgress` | `(event: OperationProgressEvent) => void` | Receives discovery, per-item, finalization, and terminal events                                     |
| `signal`     | `AbortSignal`                             | Requests cancellation. The request or transfer in flight ends, and the run stops at a safe point    |

```ts
const controller = new AbortController();

const result = await atlas.outlook.backup('user@example.com', {
  signal: controller.signal,
  onProgress(event) {
    console.log(event.phase, event.processed, event.total, event.current);
    if (event.processed >= 1000) controller.abort();
  },
});

if (result.interrupted) {
  console.log('Stopped safely. Rerun to continue from the last saved checkpoint.');
}
```

### Progress events

`OperationProgressEvent` has the same shape for every workload:

```ts
interface OperationProgressEvent {
  operation: 'backup' | 'restore' | 'save' | 'verify';
  workload: 'outlook' | 'onedrive' | 'sharepoint' | 'teams' | 'contacts' | 'calendar';
  phase: 'discovering' | 'processing' | 'finalizing' | 'completed' | 'interrupted';
  processed: number;
  total?: number;
  current?: string;
  rate?: number;
  etaMs?: number; // estimated milliseconds left, omitted until one unit has finished
}
```

The callback runs inline. Keep it fast and hand network or database writes to your own queue.

### Cancelling a run

Cancellation does not throw. The call resolves normally with `interrupted: true`.

| What was running         | Result                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A backup                 | Completed folders, drives, and libraries stay committed. The one in progress keeps its previous sync checkpoint, so the next run reads it again |
| A restore                | Reports what it wrote before the stop. The item in flight is neither counted nor listed in `errors`                                            |
| A save                   | Partial counts. A file export still finalizes a valid zip of the entries it completed. A [stream export](#streaming-exports) is destroyed instead |
| An already-aborted signal | No `discovering` event. The stream is `finalizing`, then `interrupted`                                                                        |
| The first listings, before any item | Resolves with `interrupted: true` and writes no snapshot or checkpoint                                                              |

- **Waits end at once.** In every backup, every restore and version restore, and `outlook.save()`, the signal reaches every Microsoft Graph call of the run. It ends the request in flight and any retry backoff or throttle wait, including a `Retry-After` of up to an hour, so the call resolves within moments.
- **Accepted requests still complete.** Microsoft Graph has no cancel, so a request it already accepted completes on its side and Atlas drops the answer. A Calendar or Contacts restore whose create landed anyway recognises the item by its source tag on the next run.
- **Restore writes already sent finish first,** because Microsoft 365 may have committed them: a message or attachment create, a OneDrive or SharePoint upload of up to 4 MiB, and the final chunk of a larger upload. They are counted if accepted. A larger file stopped before its final chunk is not created, and its upload session is deleted. See [Writes that are sent once](/operations/reliability#writes-that-are-sent-once).
- **Outlook messages short of attachments.** A message created before the stop whose attachments were not all uploaded is listed in `errors` once, as `<message-id>: N attachment(s) not uploaded: the run was interrupted`.
- **OneDrive and SharePoint downloads.** The signal aborts the download in flight, skips retry backoff and any `Retry-After` wait, and closes a historical version's stream, for files of every size. The interrupted file is not recorded as failed, so it keeps its retry budget. Listing, download URL lookups, the `/content` fallback, and version listing stop too. The CLI passes Ctrl+C to every backup as this signal.
- **Teams.** `backup` stops waiting on the request in flight as soon as the signal fires and resolves with `interrupted: true`. The root that request belonged to is not recorded as a failed attempt. Only the channel loop checks the signal, so a signal fired during the team or channel lookups takes effect when the loop starts.

### Outlook escalation

`atlas.outlook.backup` also accepts `hardStopSignal`, for a shutdown deadline. The CLI does not use it: its second Ctrl+C exits the process with status `130`.

```ts
const graceful = new AbortController();
const immediate = new AbortController();

process.on('SIGTERM', () => {
  graceful.abort();
  setTimeout(() => immediate.abort(), 30_000); // shutdown deadline
});

const result = await atlas.outlook.backup('user@example.com', {
  signal: graceful.signal,
  hardStopSignal: immediate.signal,
});
```

| Signal           | Effect                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`         | Ends the Graph request in flight, stops at the next message, and saves the checkpoint of every completed folder. The next run resumes there    |
| `hardStopSignal` | Drops the page in flight and its pending attachments. That folder keeps its previous checkpoint and is read again on the next run              |

Both return `interrupted: true` and keep the snapshot written so far. `hardStopSignal` trades re-reading one folder for a faster exit; use it when the deadline matters more than the lost work. OneDrive and SharePoint need no escalation signal.

## Streaming exports

Every `save`, and Outlook `saveMailbox`, accepts an `output` stream instead of `outputPath`. The archive goes straight to its consumer and is never staged on local disk. Use it on read-only or ephemeral filesystems, and for exports large enough that writing them twice costs real time.

```ts
import express from 'express';
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const app = express();
const atlas = createAtlasInstance({/* ...credentials... */});

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

The drive workloads take the same option:

```ts
await atlas.onedrive.save('user@example.com', { snapshotId, output: res });
await atlas.sharepoint.save('https://contoso.sharepoint.com/sites/Engineering', {
  snapshotId,
  output: res,
});
```

Any Node.js `Writable` works: an HTTP response, an upload stream, or a compressor.

| Situation                           | What happens                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `outputPath` in the result          | Empty string. There is no file                                                                             |
| Counts, errors, `integrityFailures` | Reported as for a file export                                                                              |
| Failed run                          | The stream is destroyed, not ended, including failures during setup before any bytes are written           |
| Interrupted run                     | The stream is destroyed without finalizing the archive. The result reports `interrupted: true`             |
| `output` together with `outputPath` | Rejected with `ConfigError`. Atlas writes one archive, and dropping either value would lose the export     |
| The consumer disconnects            | See [When the consumer disconnects](#when-the-consumer-disconnects)                                       |

A destroyed stream is deliberate: ending it would hand the consumer a short archive that opens like a complete one. Over HTTP the client sees the transfer break, so treat a body without a completed request as a failed export. Headers are already sent, so the status code cannot report the failure. Check the result, or its absence, on the server.

Memory stays bounded to one message or file: each entry is fetched, decrypted, compressed, and flushed before the next starts, and a slow consumer applies backpressure. Drive files over 4 MiB are not held at all. They are verified in a first pass and then decrypted straight into the entry. If such an object changes between the two reads, the export rejects with `ArchiveEntryAbortedError` and the stream is destroyed. See [Nothing is released before it authenticates](/security#nothing-is-released-before-it-authenticates).

### When the consumer disconnects

- The promise rejects with the destination's failure. It does not wait for a `finish` event that will not come.
- No further entries are downloaded. The run stops at the entry it could not write.
- The archive is not finalized, so the bytes already received are not a valid zip.

Handle the rejection on the server even though nobody may be listening on the client side. It is the only record that the export ended early.

## Object Lock

Pass `objectLockRequest` to any backup to apply WORM (write once, read many) retention to every object the call writes. The SDK and CLI produce the same policy for the same settings.

```ts
await atlas.outlook.backup('user@example.com', {
  objectLockRequest: { mode: 'COMPLIANCE', retentionDays: 30 },
});

await atlas.onedrive.backup('owner-id', {
  objectLockRequest: { mode: 'GOVERNANCE', retentionDays: 30 },
});
```

| Field           | Behavior                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mode`          | `GOVERNANCE` (privileged users can shorten retention) or `COMPLIANCE` (nobody can, including root). Default `GOVERNANCE` |
| `retentionDays` | Converted to an absolute `retainUntil` timestamp in UTC when the run starts                                              |

- The policy applies to each object the call writes. The bucket's own Object Lock configuration is never changed, so concurrent calls with different policies each lock exactly what they wrote.
- If a policy is requested and the bucket has versioning or Object Lock disabled, or does not support the mode, the write throws (`ObjectLockVersioningDisabledError`, `ObjectLockUnsupportedError`, `ObjectLockModeRejectedError`) instead of storing unprotected data.

::: danger
Retention under `COMPLIANCE` cannot be shortened or removed by anyone until it expires. See [Immutability and Object Lock](/operations/immutability) before choosing a mode.
:::

## Cross-tenant restore

`createTenant` returns an `AtlasTenant` handle for a second Microsoft 365 tenant. Pass it as `targetTenant` to a restore to write the backup into that tenant.

```ts
import { createAtlasInstance, createTenant } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({/* source tenant config */});

const destination = createTenant({
  tenantId: 'contoso.onmicrosoft.com',
  clientId: '<client-id>',
  clientSecret: '<client-secret>',
});
await destination.validate(); // AuthError when Microsoft Entra ID refuses the credentials

await atlas.outlook.restore('snapshot-id', {
  targetMailbox: 'user@example.com',
  targetTenant: destination,
});
```

| Method                   | Required target option |
| ------------------------ | ---------------------- |
| `outlook.restore`        | `targetMailbox`        |
| `outlook.restoreMailbox` | `targetMailbox`        |
| `contacts.restore`       | `targetMailboxId`      |
| `calendar.restore`       | `targetMailboxId`      |
| `onedrive.restore`       | `targetOwnerId`        |
| `sharepoint.restore`     | `targetSiteId`         |

- **Who does what.** The instance reads and decrypts the backup with its own S3 credentials and passphrase. The handle's credentials perform every Microsoft Graph write. A target given as an email is looked up in the destination tenant and never written to the instance's identity registry.
- **Explicit target required.** Object IDs differ between tenants, so a restore with `targetTenant` and no target fails with a `TypeError` before any Graph or storage call. A `targetTenant` that `createTenant` did not return fails with `ConfigError`.
- **Outlook needs only the target mailbox.** An Outlook restore names folders from what the snapshots recorded, so it sends Graph requests only for the target mailbox. The same holds for `outlook.save` and `outlook.saveMailbox` of a user Microsoft 365 no longer serves. Snapshots written before Atlas 5.2.3 record no folders, and restoring one needs the source mailbox, which the destination tenant cannot see, so the restore rejects with `NotFoundError` before writing a message.
- **Handle checks.** `createTenant` checks formats without network I/O: `tenantId` is a GUID or an `*.onmicrosoft.com` domain, `clientId` a GUID, `clientSecret` a single token. The secret is kept in a private field, so `JSON.stringify` and `console.log` of the handle never print it.
- **Permissions.** The destination app needs write permission for the workload being restored, for example `Mail.ReadWrite` for Outlook. See [Security](/security#tenant-profiles-and-cross-tenant-restore).
- **Clients and throttling.** Each cross-tenant restore builds its own Graph and S3 clients and releases them when it ends, also on failure. The instance's `onStorageRequest` observer still receives every S3 request. The instance's `throttleCoordinator` does not apply: the destination tenant has its own Graph budget, so its cooldowns are kept in memory for that restore.
- **Lease.** The restore takes the source owner's lease in the bucket it reads. See [Concurrent operations](#concurrent-operations).

## Bucket override

`s3Bucket` points an instance at a copy of its tenant's bucket under another name, such as an AWS S3 or Backblaze B2 replica, whose bucket names are global and cannot match the primary.

```ts
const replica = createAtlasInstance({
  tenantId: '<tenant-id>',
  clientId: '<client-id>',
  clientSecret: '<client-secret>',
  s3Endpoint: 'https://s3.eu-north-1.amazonaws.com',
  s3Region: 'eu-north-1',
  s3AccessKey: '<read-only-access-key>',
  s3SecretKey: '<read-only-secret-key>',
  s3Bucket: '<bucket>',
  encryptionPassphrase: '<passphrase>',
});
await replica.validate(); // HeadBucket on the replica bucket
const report = await replica.outlook.verify('<snapshot-id>');
```

- Every method reads and writes `s3Bucket` instead of `atlas-{tenantId}`. The tenant ID still derives the key that wraps the data key, so the copy opens with the same passphrase.
- The override is bound to `tenantId`. Any call that would open another tenant's bucket on this instance throws `ConfigError`, and a cross-tenant restore reads the source backup from `s3Bucket` without applying it to the destination tenant.
- A missing `s3Bucket` is never created. Operations that would create the bucket throw `ConfigError`.
- Read methods (`verify`, `list*`, `status`, `save`, `getStorageUsage`, and the reads of a restore) work with read-only credentials and write nothing to the bucket. `checkStorage()` writes and removes one probe object, so it needs write access.

See [Bucket override](/configuration#bucket-override) for the CLI equivalents.

## Concurrent operations

Run one operation at a time per tenant unless you have a reason not to. Each backup, restore, or save sends many Microsoft Graph requests, and running mailboxes through `Promise.all` multiplies the request rate and triggers throttling. Atlas retries throttled requests, but a sequential loop finishes sooner and more predictably.

```ts
const mailboxIds = ['alice@example.com', 'bob@example.com', 'carol@example.com'];

for (const mailboxId of mailboxIds) {
  const result = await atlas.outlook.backup(mailboxId);
  console.log(`${mailboxId}: snapshot ${result.snapshot.id}`);
}
```

From a shell, list mailboxes with `atlas outlook mailboxes` and run `atlas outlook backup -m <id>` for each one from your scheduler. The CLI handles one mailbox per invocation.

Atlas has no scheduler, so running operations at the same time is your decision. Atlas refuses the one overlap that damages backup state, two operations on the same mailbox, drive owner, site, or team. You own the remaining rules below.

### One operation per owner

Every backup, restore, version restore, deletion, and quarantine takes a lease on its owner before it reads or writes that owner's state, and holds it until it ends. A second operation on that owner rejects with `OwnerBusyError` (`ATLAS_OWNER_BUSY`, CLI exit `12`) before writing anything:

```ts
import { OwnerBusyError } from '@wisecom/atlas-sdk';

try {
  await atlas.onedrive.backup(ownerId);
} catch (err) {
  if (!(err instanceof OwnerBusyError)) throw err;
  // err.held_by_operation: 'backup' | 'delete' | 'quarantine' | 'restore' | 'purge' | 'rewrap'
  // err.lease_expires_at: ISO 8601
  await requeue(ownerId, { notBefore: err.lease_expires_at });
}
```

- **Scope.** A lease covers one workload and one owner. Mail, contacts, calendar, and OneDrive of one user are four leases and do not block each other, and neither do two owners.
- **A killed process** cannot release its lease. The owner stays busy until it expires, at most 5 minutes after the last renewal, and `lease_expires_at` says when. The next operation then takes it over, and of several waiting runs exactly one starts. A lease object that is not valid lease JSON is replaced the same way. One written by a newer Atlas is never replaced: the operation rejects with `ATLAS_FORMAT_UNSUPPORTED`.
- **A lost lease.** Before each write that advances durable state (the manifest or index, the sync checkpoint, a Teams checkpoint, a deletion), the run checks its lease without reading storage. If a renewal found another holder or no lease, or the lease ran out because storage was unreachable for its whole lifetime, the run rejects with `OwnerLeaseLostError` and commits nothing further. `OwnerLeaseLostError` is an `OwnerBusyError` with the same code and exit status, because the remedy is the same. Content already uploaded stays and is deduplicated by the next run. A failed renewal alone loses nothing: it is retried every minute, and the check starts failing 30 seconds before the unrenewed expiry.
- **SharePoint subsites.** With `includeSubsites: true`, each site takes its own lease. A busy subsite does not stop the others: its result has `summary.healthy: false` and the busy error in `summary.errors`. A busy root site rejects the call.
- **Tenant-wide runs.** `atlas teams backup --all` and the tenant-wide Outlook backup report a busy team or mailbox as that owner's failure and continue.

::: details Lease protocol
| Property | Value |
| -------- | ----- |
| Object   | One plain JSON object per workload and owner, not encrypted, so operations without the tenant key can take it. See [Owner leases](/operations/storage-layout#owner-leases) for the paths and what it reveals |
| Body     | A random ID for the run, the operation (`backup`, `delete`, `quarantine`, `restore`, or `purge` and `rewrap` on the tenant lease), `acquired_at`, and `expires_at`. No host name, user name, or process ID |
| Acquire  | A create-only write (`If-None-Match: *`), then a read to confirm this run is the holder: one `PUT` and one `GET` |
| Lifetime | 5 minutes after the last write |
| Renewal  | Every 60 seconds: one `GET`, then one `PUT` with `If-Match` on the ETag just read. The timer does not keep the Node.js process alive |
| Takeover | An expired lease is replaced by compare-and-swap |
| Release  | When the operation ends with a result, an error, or a cancellation: one `GET`, and one `DELETE` if the lease is still this run's. If the delete is refused, one `PUT` with `If-Match` marks it released, and the next operation takes it at once. A failed release is logged and never replaces the operation's result |
| Cost     | Requests per run and per minute, never per object |
:::

### Tenant lease

`purgeTenantData()`, `rewrapDataKey()`, and the `keys` methods take one lease for the whole tenant, stored at `_meta/tenant-lease.json` with the tenant ID as its owner ID, renewed every 60 seconds and released when the call ends, also on failure.

- The tenant call writes its lease, then lists every owner lease of the tenant. Any live owner lease makes it reject with `OwnerBusyError` before it writes anything else, naming one busy owner in `workload` and `owner_id`.
- Every owner operation does the reverse: after writing its own lease it reads the tenant lease, and a live one makes it release its own and reject with `OwnerBusyError`, `held_by_operation` set to `purge` or `rewrap`.
- Because each side writes before it reads, two calls that start at the same moment cannot both proceed. An owner lease that has expired, was released, or does not parse does not block the tenant call.
- A tenant lease whose purge was killed expires 5 minutes after its last renewal and blocks the tenant's owner operations until then.
- Cost: one extra `GET` per owner acquire. The tenant call lists each workload's lease prefix, a listing of that workload's `_meta/` tree, so its cost grows with the number of owners.

### What Atlas makes safe

Operations on different owners of one tenant can run at once, on one instance or in separate processes against the same bucket. Content, manifests, sync checkpoints, version indexes, and staging objects are kept per mailbox, drive owner, or site. The tenant-wide objects are written safely:

| Object                   | How concurrent writers are handled                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_meta/dek.enc`          | Created with `If-None-Match: *`. A run that loses the race adopts the stored key                                                                                  |
| `identity-registry.json` | Every write is a compare-and-swap on the ETag. A losing writer re-reads and re-applies its change, up to 8 attempts                                               |
| The tenant bucket        | A run that loses the `CreateBucket` race uses the bucket the other run created                                                                                    |
| Object Lock retention    | Applied to each object a run writes. No run changes the bucket's lock configuration. A lease is never written with retention                                      |
| Per-owner state          | Sync checkpoints, the Outlook `latest.json` pointer, version indexes, staging objects, and Teams checkpoints are written only by the run holding the owner's lease |

These conditional writes, the lease included, need a backend that honours `If-Match` and `If-None-Match`. `checkStorage()` and `atlas storage-check` probe both. See [Storage](/self-hosting/storage#owner-leases-and-conditional-writes).

### What the host must guarantee

- **Restores and leases.** Restore takes the source owner's lease in the bucket it reads, also for a cross-tenant restore, so it never runs next to a backup, deletion, quarantine, or second restore of that owner. A restore whose storage credentials cannot write the lease (HTTP `403`) still runs, without a lease, and logs `concurrent-run protection is off for this restore`; a backup, deletion, or second restore of that owner is then not refused. A live lease held by another operation still refuses the restore, owner or tenant, because reading a lease needs no write access.
- **Readers take no lease.** Save, verify, status, and the listings only read, so they can run next to a backup of the same owner. A deletion or quarantine running at the same time can remove the snapshot they are reading.
- **Clocks.** Keep the clocks of hosts that share a bucket within a few minutes of each other. A host whose clock is ahead by more than the time left on a live lease (4 to 5 minutes in steady state) sees it as expired and takes over a running operation. The displaced run notices within 60 seconds and stops before its next commit, but both ran for that long.
- **Backends that ignore write conditions** let two runs take the same lease. Each finds out at its next renewal, so the overlap is bounded at 60 seconds but not prevented. Schedule one operation per owner yourself until `checkStorage()` reports `conditionalWrites.support: 'supported'`.
- **Mixed versions.** A host running an Atlas version older than the lease does not see it. Upgrade every host that writes to a bucket before relying on it.
- **Disposal.** Let operations finish or cancel them before `dispose()`. See [Instance lifecycle](#instance-lifecycle).

### Sharing throttle cooldowns

When Microsoft Graph throttles a request, Atlas pauses the matching request pool until the cooldown ends. The default coordinator keeps those cooldowns in memory, so each process only learns about the throttling it receives itself. Supply a `throttleCoordinator` when several processes work on the same tenant:

```ts
import type { ThrottleCoordinator } from '@wisecom/atlas-sdk';

// A coordinator backed by state every worker for this tenant can see.
const throttleCoordinator: ThrottleCoordinator = {
  async wait(pool) {
    await sharedCooldowns.waitUntilClear(tenantId, pool);
  },
  raise(pool, retry_after_ms) {
    sharedCooldowns.extend(tenantId, pool, Date.now() + retry_after_ms).catch((err) => {
      console.warn('could not share the cooldown', err);
    });
  },
};

const atlas = createAtlasInstance({ ...config, throttleCoordinator });
```

| Call                                   | When Atlas makes it                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `wait(pool, scope?)`                   | Before every HTTP attempt made through a Graph connector                                                |
| `raise(pool, retry_after_ms, scope?)`  | On every `429`, with Graph's `Retry-After`, or 30 seconds when there is none                            |

- `pool` is a `GraphServicePool`: `outlook`, `sharepoint_onedrive`, `identity`, or `teams`. `scope` is a `ThrottleScope`, `{ ownerId }`: the normalized mailbox ID on Outlook requests and the normalized team ID on Teams requests. Listing the tenant's teams, and drive and identity requests, pass no scope.
- Coordinated calls: mailbox backup and restore, mailbox discovery, user lookups, every Teams call, and every OneDrive and SharePoint connector call. Drive downloads from pre-authenticated URLs, whole or chunked, and resumable upload chunks are coordinated on `sharepoint_onedrive` as well: each attempt waits, and a `429` or `503` with `Retry-After` raises the cooldown. Their own retry backoff applies on top.
- The default coordinator keeps one cooldown per pool, plus one per mailbox for `outlook` and one per team for `teams`. See [Throttle handling](/operations/graph-rate-limits#throttle-handling) for what each cooldown pauses.
- A coordinator written against the two-argument form (`wait(pool)`, `raise(pool, retry_after_ms)`) keeps working. It ignores the scope, so it treats every Outlook or Teams throttle as pool-wide.

Rules for your implementation:

- `wait` runs before every attempt. Answer it from local state, such as a cached cooldown deadline, not a network round trip.
- Cooldowns must not add up: a shorter `raise` never shortens a longer cooldown already in force.
- A supplied coordinator fails open. If `wait` rejects, Atlas sends the request anyway. If `raise` throws or rejects, Atlas logs a warning and keeps backing off on Graph's own `Retry-After`. An outage of your shared state costs coordination, not the operation.
- Per-mailbox request windows, in-flight limits, and Teams pacing stay inside each instance whatever coordinator is used. Set `teamsPacingShare` so the processes of one tenant split its Teams budget. See [Teams pacing](/teams-backup#pacing).

## Graph cost tracking

`outlook.backup`, `outlook.restore`, `outlook.restoreMailbox`, `outlook.save`, `outlook.saveMailbox`, `outlook.checkMailboxStatus`, and `teams.backup` return `graphCost`, the Microsoft Graph requests they made, broken down by request pool.

```ts
const result = await atlas.outlook.backup('user@example.com');

console.log(result.graphCost);
// {
//   requestsTotal: 852,
//   byService: {
//     outlook: { requests: 847, resourceUnits: 847, uploadBytes: 0 },
//     identity: { requests: 5, resourceUnits: 5, uploadBytes: 0 },
//   },
//   requestsByType: {
//     // Keys are request-type labels, recorded exactly as Atlas emits them.
//     delta_sync: 312, fetch_attachments: 530,
//     list_folders: 5, mailbox_exists: 2, list_users: 3,
//   },
//   elapsedMs: 45200,
// }
```

The values are illustrative.

- For a method that takes a mailbox address, the count includes the lookup of its object ID.
- Other methods use quota without reporting it. `listAvailableMailboxes()` lists users, and `listSnapshots`, `deleteMailboxData`, and `getMailboxStats` look up an address once, cached after the first call. Budget for them separately.

### What counts

Each request is counted once, as it is sent:

- **Every page.** An incremental sync that follows `@odata.nextLink` across 40 pages counts 40.
- **Every attempt.** A call throttled twice and then succeeding counts 3.
- **Every request inside a `$batch`.** Microsoft Graph charges each sub-request against the mailbox's limits, so a batch of 20 counts 20, and a resend of the 5 still pending counts 5. Reaction and pin capture (`fetch_extended_properties`) is the only batched read.

`requestsByType` labels each request with the operation that issued it. A paginated `delta_sync` shows all its pages under one label.

### Cost when an operation fails

A failed run can be the most expensive run in a job: a sync that fails on page 400, or a request that spends its whole retry budget throttled, may use more quota than any successful run. The cost is attached to the thrown error and read with `getGraphCost`:

```ts
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

::: danger
A scheduler that reads cost only on success treats the most expensive runs as free. It then queues the next mailbox into a tenant that is already throttled, which draws another throttling response and extends the throttle.
:::

### OperationCost type

```ts
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

type GraphServicePool = 'outlook' | 'sharepoint_onedrive' | 'identity' | 'teams';
```

`byService` lists only the pools the operation used. A mail backup usually has `outlook` and `identity` entries.

### GRAPH_SERVICE_LIMITS

The published Microsoft Graph limits are exported as a constant, so a scheduler can use the same values as Atlas. Pool names stay as keys, so `GRAPH_SERVICE_LIMITS[pool]` works with a pool name read from `byService`.

```ts
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

A common pattern is one queued job per mailbox, with `graphCost` setting a cooldown before the next job starts. This example uses pg-boss 10 or later, whose `work` handler receives an array of jobs:

```ts
import { createAtlasInstance, getGraphCost, GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-sdk';
import type { OperationCost } from '@wisecom/atlas-sdk';
import PgBoss from 'pg-boss';

const boss = new PgBoss(DATABASE_URL);
await boss.start();

await boss.work('backup-mailbox', async ([job]) => {
  // The job carries IDs only. Load credentials from your secret store at run time.
  const { tenantId, mailboxId } = job.data;
  await using atlas = createAtlasInstance(await loadTenantConfig(tenantId));

  let result;
  try {
    result = await atlas.outlook.backup(mailboxId);
  } catch (err) {
    // A failed run still used quota. Record it, then let pg-boss apply its retryLimit.
    await recordCost(mailboxId, getGraphCost(err));
    throw err;
  }

  await recordCost(mailboxId, result.graphCost);

  // Interruptions and folder errors return normally. Fail the job so pg-boss retries it.
  if (result.summary.interrupted || result.summary.folderErrors.length > 0) {
    throw new Error(`Partial backup of ${mailboxId}: ${result.summary.folderErrors.join('; ')}`);
  }

  // Cooldown from the Outlook pool limit, the bottleneck for mail backup
  const outlookLimits = GRAPH_SERVICE_LIMITS.outlook;
  const outlookUsed = result.graphCost?.byService.outlook?.requests ?? 0;
  const usageRatio = outlookUsed / outlookLimits.requestsPerWindow;
  const cooldownMs = Math.ceil(usageRatio * outlookLimits.windowDurationMs);

  // Re-enqueue only after success. Failures retry through pg-boss, so a permanent error
  // such as WrongPassphraseError cannot loop.
  await boss.send('backup-mailbox', job.data, {
    startAfter: new Date(Date.now() + cooldownMs),
  });
});

async function recordCost(mailboxId: string, cost: OperationCost | undefined): Promise<void> {
  if (!cost) return;
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
}
```

- The Outlook limit applies per mailbox, so each mailbox's cooldown is independent. Workers for different mailboxes do not share Outlook quota.
- The `sharepoint_onedrive` limit applies per tenant. For OneDrive jobs, add up `resourceUnits` across the tenant's owners and compare the total with `GRAPH_SERVICE_LIMITS.sharepoint_onedrive.resourceUnitsPerMinute['<tier>']` before scheduling the next job.

## Damaged stored objects

A snapshot manifest, a Teams snapshot index, or a OneDrive or SharePoint version index can exist and still fail to decrypt, parse, or name the path it sits under. Atlas reports each one by object path with code `ATLAS_CONTENT_UNREADABLE`, never as an empty result.

```ts
import { UnreadableObjectsError } from '@wisecom/atlas-sdk';

try {
  const snapshots = await atlas.onedrive.listSnapshots('user@example.com');
} catch (err) {
  if (!(err instanceof UnreadableObjectsError)) throw err;
  const readable = err.partial_result ?? []; // camelCase rows, as listSnapshots returns them
  for (const key of err.unreadable_keys) {
    console.warn(`Damaged backup object ${key}`);
  }
}

const status = await atlas.onedrive.checkStatus('user@example.com');
for (const key of status.unreadableKeys ?? []) {
  await atlas.onedrive.quarantine(key); // after checking bucket versioning for an intact copy
}
```

| Call                                                 | What it does                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listSnapshots`, `listMailboxes`, `listFileVersions` | Rejects with `UnreadableObjectsError`. `unreadable_keys` names the damaged objects, `partial_result` holds everything readable, in the call's camelCase shape      |
| `checkStatus`, `checkMailboxStatus`                  | Resolves. `unreadableKeys` names the damaged manifests, and `lastSnapshotId` is the newest readable one                                                          |
| `backup`                                             | Resolves. `summary.unreadableKeys` names the damaged manifests the run skipped                                                                                   |
| OneDrive and SharePoint `restore`, `save`, `verify`  | Resolve with `unreadableKeys` when the damaged manifest is newer than the target. Reject with `UnreadableObjectsError` when the target's chain may need it        |
| Outlook `restore`, `save`, `verify`, `readMessage`   | Reject with `UnreadableObjectsError` while any manifest of the mailbox is damaged                                                                                |
| `restoreVersion`                                     | Rejects with `UnreadableObjectsError` while any version index object of the owner or site is damaged                                                             |
| Teams `listSnapshots`, `status`                      | Resolve. `listSnapshots` names damaged indexes in `unreadableKeys`. `status` names damaged indexes and channel cursors in `unreadableKeys`, and the indexes alone in `unreadableIndexKeys`; only those need `quarantine`, since the next backup rewrites a damaged cursor |

The listings reject rather than resolve because an array has nowhere to carry the keys. The error's own fields are snake_case, like every error property.

`quarantine(storageKey)` exists on every workload namespace. It moves the object to `_quarantine/{storageKey}` and resolves with `{ storageKey, quarantineKey, kind, reason }`, where `kind` is `manifest` or `version_index`.

- Teams accepts snapshot index keys only (`teams/manifests/{team_id}/{snapshot_id}.json`).
- It rejects with `NotFoundError` when nothing is stored at the key or the object reads cleanly.
- It rejects with `ObjectLockRetainedError` when retention refuses the removal. The quarantined copy then stays next to the original.

See [Damaged manifests and version indexes](../troubleshooting.md#damaged-manifests-and-version-indexes) for why some restores refuse and how to recover.

## Errors

Every deliberate Atlas failure is an `AtlasError` with a stable `code`. Branch on the class or the code, never on the message, because wording changes between releases.

```ts
import { AtlasError, MailboxNotLicensedError, WrongPassphraseError } from '@wisecom/atlas-sdk';

try {
  await atlas.outlook.backup('user@example.com');
} catch (err) {
  if (err instanceof MailboxNotLicensedError) {
    await reassignLicense('user@example.com'); // then schedule a new run
  } else if (err instanceof WrongPassphraseError) {
    logger.error('Passphrase rejected. Do not retry with the same passphrase', { code: err.code });
  } else if (err instanceof AtlasError) {
    logger.error('Atlas backup failed', { code: err.code });
  }
  throw err;
}
```

| Class                               | `code`                       | Meaning                                                                                                                                                         |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AtlasError`                        | any of the below             | Base class. Catch it to separate deliberate failures from bugs                                                                                                  |
| `AuthError`                         | `ATLAS_AUTH_DENIED`          | Microsoft Graph or storage refused the call: missing permission or admin consent                                                                                |
| `MissingGraphPermissionsError`      | `ATLAS_AUTH_DENIED`          | Subclass of `AuthError`: Graph answered 403 with a missing-grant code and nothing showed the grant working. `permissions` names what to grant                    |
| `GraphAccessRefusedError`           | `ATLAS_ACCESS_REFUSED`       | Graph refused one site, drive, or owner. Permanent for that resource, not an `AuthError`. See [Graph failures](#graph-failures)                                  |
| `GraphUnavailableError`             | `ATLAS_GRAPH_UNAVAILABLE`    | Graph answered 500, 502, 503, or 504, or the connection failed or timed out, until retries ran out. Transient. See [Graph failures](#graph-failures)            |
| `ThrottledError`                    | `ATLAS_THROTTLED`            | Graph kept throttling until retries ran out. See `retry_after_ms` below                                                                                         |
| `MailboxNotLicensedError`           | `ATLAS_MAILBOX_NOT_LICENSED` | No Exchange Online license, so Graph does not serve the mailbox                                                                                                 |
| `NotFoundError`                     | `ATLAS_NOT_FOUND`            | Snapshot, mailbox, drive, site, or object does not exist, or a folder, file, or message selector matched nothing                                                |
| `WrongPassphraseError`              | `ATLAS_WRONG_PASSPHRASE`     | The passphrase could not unwrap the data key. A damaged content object is a per-file entry in a restore result's `errors`, not this error                       |
| `ObjectLockRetainedError`           | `ATLAS_OBJECT_LOCK_RETAINED` | The object is under retention or a legal hold. `key` is set                                                                                                     |
| `StorageError`                      | `ATLAS_STORAGE_FAILURE`      | Storage failed for a reason other than permission, retention, or absence                                                                                        |
| `PreconditionFailedError`           | `ATLAS_STORAGE_FAILURE`      | A conditional write lost a race (HTTP 412)                                                                                                                      |
| `StoredObjectConflictError`         | `ATLAS_STORAGE_FAILURE`      | A create-only manifest or index write found a different object at its path and left it in place. `key` is set. A new run uses a new snapshot ID                |
| `ConfigError`                       | `ATLAS_CONFIG_INVALID`       | Credentials, endpoint, passphrase, option, or tenant is missing or unusable                                                                                     |
| `ObjectLockVersioningDisabledError` | `ATLAS_CONFIG_INVALID`       | Retention requested, but bucket versioning is off                                                                                                               |
| `ObjectLockUnsupportedError`        | `ATLAS_CONFIG_INVALID`       | Retention requested, but the bucket has no Object Lock                                                                                                          |
| `ObjectLockModeRejectedError`       | `ATLAS_CONFIG_INVALID`       | The backend rejected the requested retention mode                                                                                                               |
| `RefusedWriteError`                 | `ATLAS_WRITE_REFUSED`        | Atlas refused to store a manifest, index, or checkpoint it built: too large for one JSON document, rejected by its own reader's checks, or not decrypting back. Nothing was written. `key` is set. See [Refused and unconfirmed metadata writes](/troubleshooting#refused-and-unconfirmed-metadata-writes) |
| `UnreadableContentError`            | `ATLAS_CONTENT_UNREADABLE`   | Stored data or MIME content could not be decoded. Not exported                                                                                                  |
| `UnreadableObjectsError`            | `ATLAS_CONTENT_UNREADABLE`   | Named manifests or version indexes could not be read. See `unreadable_keys` and [Damaged stored objects](#damaged-stored-objects)                               |
| `UnsupportedFormatVersionError`     | `ATLAS_FORMAT_UNSUPPORTED`   | Stored content was written by a newer Atlas format. Upgrade Atlas. Not exported                                                                                 |
| `SnapshotNotNewestError`            | `ATLAS_SNAPSHOT_NOT_NEWEST`  | `deleteSnapshot` refused a snapshot that newer snapshots are built on. See `snapshot_id` and `newer_snapshot_ids`                                               |
| `OwnerBusyError`                    | `ATLAS_OWNER_BUSY`           | Another operation holds the mailbox, drive owner, site, or team, or a purge or key re-wrap holds the tenant. Nothing was written. See [Concurrent operations](#concurrent-operations) |
| `OwnerLeaseLostError`               | `ATLAS_OWNER_BUSY`           | Subclass of `OwnerBusyError`: this run lost its lease before a commit point, so it stopped without writing the manifest, checkpoint, or deletion that followed  |

| Error                          | Properties                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| every `AtlasError`             | `code`, and `cause` with the underlying Graph or AWS SDK error, for logging. Branching never depends on it     |
| `ThrottledError`               | `retry_after_ms`                                                                                               |
| `GraphUnavailableError`        | `status_code`, `graph_code`, `retries`, `elapsed_ms`                                                           |
| `GraphAccessRefusedError`      | `site_id`, `drive_id`, `owner_id`, `reason`, `status_code`, `graph_code`                                       |
| `MissingGraphPermissionsError` | `permissions`, `status_code`, `graph_code`                                                                     |
| `OwnerBusyError`, `OwnerLeaseLostError` | `workload`, `owner_id`, `held_by_operation`, `lease_expires_at`                                       |
| `SnapshotNotNewestError`       | `snapshot_id`, `newer_snapshot_ids`                                                                            |
| `UnreadableObjectsError`       | `unreadable_keys`, `partial_result`                                                                            |
| `ObjectLockRetainedError`, `StoredObjectConflictError`, `RefusedWriteError` | `key`                                                             |

**`ThrottledError`** is thrown when Microsoft Graph keeps throttling past 12 retries, when a call that has already waited 24 minutes would have to wait again, or at once when `Retry-After` is longer than one hour (the message then names the value). `retry_after_ms` is the last `Retry-After` Graph sent, in milliseconds, or `undefined` when it sent none. The CLI exits with code `3` for this error. [Retries and fail-safes](/operations/reliability#microsoft-graph-requests) lists the backoff, jitter, and wait budget in full.

**`WrongPassphraseError`** may also mean damage. AES-GCM reports a wrong key and damaged ciphertext as the same authentication failure; Atlas names the passphrase because it is the likelier cause and the only one an operator can act on. The raw crypto error stays in `cause`. If the passphrase is known to be correct for that tenant, treat the error as a possible integrity problem and run `atlas verify` on the snapshot.

### Graph failures

```ts
import { GraphAccessRefusedError, GraphUnavailableError, ThrottledError } from '@wisecom/atlas-sdk';

try {
  await atlas.sharepoint.backup(siteId);
} catch (err) {
  if (err instanceof GraphAccessRefusedError) {
    // Retrying returns the same answer. A container is unsupported; another site may need a
    // per-site grant first.
    if (err.reason === 'file_storage_container') markUnsupported(err.site_id);
    else flagForGrantReview(err.site_id, err.graph_code);
  } else if (err instanceof GraphUnavailableError || err instanceof ThrottledError) {
    scheduleLater(err.code); // transient: back off at the run level
  } else {
    throw err;
  }
}
```

| Code                      | Retry?                                                                               | Fields                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ATLAS_GRAPH_UNAVAILABLE` | Yes, later. The call already spent its retry budget                                  | `status_code` (last HTTP status, `undefined` when no response arrived), `graph_code` (`undefined` without a response), `retries` (up to 12, fewer when the 24-minute wait budget ran out first), `elapsed_ms` |
| `ATLAS_ACCESS_REFUSED`    | Not as is. A container is unsupported; check another resource's per-site grant first | `site_id`, `drive_id`, `owner_id` (what the call addressed, the others `undefined`), `reason`, `status_code`, `graph_code`                                                                                                        |
| `ATLAS_AUTH_DENIED`       | No. Grant the permission first                                                       | `MissingGraphPermissionsError` adds `permissions`, `status_code`, `graph_code`                                                                                                                                                    |

- **`GraphUnavailableError` messages are never empty.** They name the retry count, the elapsed time, the HTTP status when there was one, the Graph error code when Graph sent one, and an excerpt of the response body when Graph sent no message, or `no HTTP response` with the transport error when the connection failed:

  ```
  Microsoft Graph was unavailable after 12 retries over 1416 s: HTTP 504 -- UnknownError -- {"code":"UnknownError","message":"",...}
  ```

- An exhausted `429` stays `ThrottledError`. A failure Atlas does not retry, such as a `400`, is rethrown unchanged.
- **`GraphAccessRefusedError`** is raised for a `403` whose code does not name a missing permission, or, for SharePoint, a refused site while the same app can read the tenant's root site. A SharePoint Embedded container is the known case.
- **`reason`** is `file_storage_container` when the refused site's URL is under `/contentstorage/`, the shape of a [SharePoint Embedded container](/sharepoint-backup#sharepoint-embedded-containers), and `access_refused` otherwise. A site given by ID is refused before Atlas learns its URL, so a container backed up by ID reports `access_refused`. Use `listSites()`, whose results carry `kind`, or `isFileStorageContainerSite(webUrl)` on a URL from your own discovery, to skip containers before backing them up.
- **Telling the two SharePoint causes apart** costs at most one extra request: on a missing-grant `403`, Atlas sends one `GET /sites/root?$select=id` and reuses the answer for 10 minutes per instance.

## Exports

`@wisecom/atlas-sdk` exports an explicit list. Internal domain types and ports are not exported. Infer other result types from `AtlasInstance` rather than importing internal models.

- **Factories and values:** `createAtlasInstance`, `createTenant`, `getGraphCost`, `getStorageUsageToken`, `GRAPH_SERVICE_LIMITS`, `isFileStorageContainerSite`
- **Tenant handles:** `AtlasTenant`, `AtlasTenantConfig`
- **Instance types:** `AtlasInstance`, `AtlasInstanceConfig`, `LogSink`, `LogFields`, `ThrottleCoordinator`, `ThrottleScope`
- **Sub-API types:** `OutlookApi`, `OneDriveApi`, `SharePointApi`, `TeamsApi`, `ContactsApi`, `CalendarApi`
- **Workload options and results:** the `Outlook*`, `OneDriveSdk*`, `SharePointSdk*`, `TeamsSdk*`, `ContactsSdk*`, and `CalendarSdk*` types each API uses
- **Operation control:** `SdkOperationOptions`, `OperationProgressEvent`, `OperationProgressCallback`, `OperationProgressPhase`
- **Storage usage:** `StorageUsage`, `StorageUsageTotals`, `StorageOwnerUsage`, `StorageUsageOptions`, `StorageUsageBreakdown`, `StorageUsageWorkload`, `LogicalWorkload`
- **Storage request events:** `StorageRequestEvent`, `StorageRequestObserver`, `StorageRequestWorkload`, `StorageKeyClass`
- **Shared enums and requests:** `ObjectLockMode`, `ObjectLockRequest`, `BackupSyncMode`, `GraphServicePool`
- **Graph cost types:** `OperationCost`, `ServicePoolCost`, `GraphServiceLimits`
- **Quarantine:** `QuarantineResult`
- **Errors:** `AtlasError`, `AtlasErrorCode`, `AuthError`, `MailboxNotLicensedError`, `NotFoundError`, `ThrottledError`, `WrongPassphraseError`, `ObjectLockRetainedError`, `StorageError`, `ConfigError`, `UnreadableObjectsError`, `SnapshotNotNewestError`, `StoredObjectConflictError`, `RefusedWriteError`, `OwnerBusyError`, `OwnerLeaseLostError`, `MissingGraphPermissionsError`, `GraphAccessRefusedError`, `GraphAccessRefusalReason`, `GraphUnavailableError`, `ObjectLockVersioningDisabledError`, `ObjectLockUnsupportedError`, `ObjectLockModeRejectedError`, `PreconditionFailedError`
- **SharePoint sites:** `SharePointSiteKind`

## See also

- [CLI commands](/reference/cli)
- [SDK examples](/reference/examples)
- [Storage request events](/reference/storage-request-events)
- [Retries and fail-safes](/operations/reliability)
- [Security](/security)
- [Migrating to v7](/migration/v7)
- [Migrating to v6](/migration/v6)
