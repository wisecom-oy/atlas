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

The tenant is bound at creation time, so every method operates within that tenant scope. Methods are async and return Promises.

Everything on the public surface is camelCase: methods, config, option fields and result fields alike. Before v5.0.0 the methods were camelCase and every option and result field was snake_case, because the internal model leaked through as the public API. Atlas is still snake_case internally, and the conversion happens at the SDK boundary, so `atlas.outlook.backup(id, { forceFull: true })` returns `{ summary: { attachmentsStored } }` and never a mixture of the two. See [Migrating to v5](/migration/v5) for the full list of renamed fields.

Two kinds of key stay verbatim, because they are data rather than field names: the keys of a map Atlas did not choose (`deltaLinks` keyed by Graph folder id, `requestsByType` keyed by request label, `byService` keyed by pool name), and the raw Graph payload in `readMessage().message`, which has to keep matching what Graph returned and what the stored blob contains.

### Logging

The SDK is **silent by default**: no Atlas output reaches the host's stdout or
stderr. Pass a `logger` to receive it.

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

The `LogSink` interface is those four methods and nothing else, so `pino`,
`winston`, an OpenTelemetry exporter, or `console` all satisfy it with an
adapter of a few lines.

Every line carries `fields` identifying where it came from:

```json
{ "tenantId": "00000000-0000-0000-0000-000000000000", "operation": "backup" }
```

`operation` is the SDK method that produced the line, so one process serving
many tenants can attribute output without correlating by timestamp. The tag is
applied per call, and concurrent operations on separate instances never share a
sink.

There is no `success` level: those lines arrive as `info`. Progress output is
dropped rather than logged, because it is terminal cursor control rather than a
record. Use the [progress events](#progress-and-cancellation) for that.

`debug` is passed to the sink regardless of the `DEBUG` environment variable.
The host asked for the lines, so the host's logger decides its own level.

::: tip Logs are not the only channel
Anything operationally significant is also in the typed result:
`summary.warnings`, `summary.errors`, `summary.excludedFolders`,
`integrityFailures`, and the failed-item ledger. Never parse log text to find
out what a run did.
:::

::: warning Behaviour change in 4.1.0
Earlier SDK versions wrote chalk-coloured `[*]`, `[!]` and `[x]` lines straight
to the console, including raw ANSI cursor control on a TTY. An embedder that
relied on that output has to pass a `logger` to keep seeing it. The CLI is
unaffected and its output is unchanged.
:::

### Instance lifecycle

An instance owns an S3 client with keep-alive socket pools and a cache of what
it has already asked of the bucket. **Create one per tenant, dispose it when
done.**

```typescript
const atlas = createAtlasInstance({/* ...config... */});
try {
  await atlas.outlook.backup('user@company.com');
} finally {
  await atlas.dispose();
}
```

On Node 20 and later, `await using` does it for you:

```typescript
await using atlas = createAtlasInstance({/* ...config... */});
await atlas.outlook.backup('user@company.com');
// disposed at the end of the block, including on a throw
```

`dispose()` closes the S3 client's sockets, clears the instance's bucket cache,
and drops the container's bindings. It is idempotent, so a `finally` block and
an `await using` scope can both fire safely, and it never throws: a step that
fails is logged and the remaining steps still run. The instance must not be used
afterwards.

A long-lived service that creates an instance per request and never disposes it
accumulates socket pools for the lifetime of the process.

::: warning Passphrases cannot be zeroed
`dispose()` drops the instance's reference to your `encryptionPassphrase`, and
`TenantContext.destroy()` already zeroes the derived key buffers. The passphrase
_string_ cannot be wiped: JavaScript strings are immutable, so the value stays
in the heap until the garbage collector reclaims it, and no library can change
that. Where that matters, keep the passphrase in a `Buffer` on your side and
treat the process boundary, not `dispose()`, as the security boundary.
:::

Bucket caches are per instance. Two instances pointing at **different S3
endpoints** with same-named buckets no longer answer each other's questions
about whether a bucket exists or supports Object Lock, which before 4.1.0 could
skip creating a bucket that was not there.

## Available Methods

`createAtlasInstance` returns an `AtlasInstance` with three workload sub-APIs and cross-cutting tenant methods:

```typescript
// --- Outlook (mailboxes) ---
const result = await atlas.outlook.backup('user@company.com', { forceFull: true });
const mailboxes = await atlas.outlook.listMailboxes();
const snapshots = await atlas.outlook.listSnapshots('user@company.com');
const verification = await atlas.outlook.verify('snapshot-id');
const restore = await atlas.outlook.restore('snapshot-id', { folderName: 'Inbox' });
const fullRestore = await atlas.outlook.restoreMailbox('user@company.com');
const save = await atlas.outlook.save('snapshot-id', {
  folderName: 'Inbox',
  outputPath: 'backup.zip',
});
const message = await atlas.outlook.readMessage('snapshot-id', '42');
const status = await atlas.outlook.checkMailboxStatus('user@company.com');

// --- OneDrive (owner: email or Entra object id) ---
const od = await atlas.onedrive.backup('john.doe@example.com');
await atlas.onedrive.verify('john.doe@example.com', 'od-snap-123');
await atlas.onedrive.checkStatus('john.doe@example.com');
const odStats = await atlas.onedrive.getStats('john.doe@example.com'); // omit the owner for every drive

// --- SharePoint (site: URL or composite site id; one result per backed-up site) ---
const site = 'https://contoso.sharepoint.com/sites/Example';
const [sp] = await atlas.sharepoint.backup(site);
const tree = await atlas.sharepoint.backup(site, { includeSubsites: true });
await atlas.sharepoint.verify(site, 'sp-snap-123');
const sites = await atlas.sharepoint.listSites();
const spStats = await atlas.sharepoint.getStats(site); // omit the site for every site

// --- Cross-cutting (tenant scope) ---
const check = await atlas.checkStorage({ mode: 'GOVERNANCE', retentionDays: 30 });
const stats = await atlas.getBucketStats();
await atlas.replicateSnapshot('snapshot-id', [offsite]);
```

Method names mirror the CLI structure: `atlas outlook backup` maps to `atlas.outlook.backup()`, `atlas onedrive backup` to `atlas.onedrive.backup()`, and so on. Every capability the CLI can reach is reachable from the SDK; the SDK exposes some the CLI does not. See [SDK Examples](/reference/examples) for production-ready patterns.

### Identifiers

Drive methods take the same identifiers the CLI takes, and normalise them the same way.

| Namespace            | Accepted                                                          | Normalisation                                                                     |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `atlas.onedrive.*`   | An email or UPN, or an Entra object id                            | An argument containing `@` is resolved through Graph; anything else is used as is |
| `atlas.sharepoint.*` | A site URL or hostname, or a composite `host,siteGuid,webGuid` id | An argument without commas is resolved through Graph; anything else is used as is |

Resolution failures throw, so a mistyped address fails the call instead of quietly addressing a scope that does not exist. Resolved identities are cached per instance, and `atlas.onedrive.backup` records the resolved email and display name with the snapshot, which is what makes owners readable in later listings. `resolveUser` and `resolveSite` remain available when you want the lookup on its own.

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

`atlas.outlook.backup` accepts a third option, `hardStopSignal`, for the case where graceful is not fast enough. This is the escalation the CLI wires to a second Ctrl+C:

```typescript
const graceful = new AbortController();
const immediate = new AbortController();

process.on('SIGTERM', () => graceful.abort());
setTimeout(() => immediate.abort(), 30_000); // shutdown deadline

const result = await atlas.outlook.backup('user@company.com', {
  signal: graceful.signal,
  hardStopSignal: immediate.signal,
});
```

| Signal           | Effect                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`         | Finishes the page in flight, stores its attachments, and persists the delta link for every completed folder. The next run resumes from there. |
| `hardStopSignal` | Drops the page in flight and its pending attachments. The affected folder keeps its previous delta link and is re-enumerated on the next run. |

Both return a result with `interrupted: true` rather than throwing, and both keep the snapshot manifest that was written for the work already done. `hardStopSignal` trades re-enumeration of one folder for a faster exit, so use it when a deadline matters more than the wasted work.

OneDrive and SharePoint backups accept `signal` only. Their long unit of work is a single file transfer, and aborting one mid-stream is not implemented, so there is nothing for an escalation to shorten.

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

If the signal is already aborted when the operation is called, no `discovering` event is emitted — the stream contains only `finalizing` followed by `interrupted`. The event stream never claims work that did not happen, so a progress bar driven by `discovering` will not paint a "starting..." state for a run that is already over.

The callback is optional and runs inline with the operation. Keep it fast; move network writes or database updates to your own queue.

## Outlook API Reference

| Method                                | CLI equivalent             | Description                                                                                        |
| ------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `backup(mailboxId, options?)`         | `atlas outlook backup -m`  | Backup a single mailbox                                                                            |
| `verify(snapshotId, options?)`        | `atlas outlook verify`     | Verify full restorable state (chain-aware, incl. attachments); `{ fast: true }` for existence-only |
| `restore(snapshotId, options?)`       | `atlas outlook restore -s` | Restore from a snapshot                                                                            |
| `restoreMailbox(mailboxId, options?)` | `atlas outlook restore -m` | Restore all snapshots for a mailbox                                                                |
| `save(snapshotId, options?)`          | `atlas outlook save -s`    | Export snapshot as EML zip                                                                         |
| `saveMailbox(mailboxId, options?)`    | `atlas outlook save -m`    | Export all snapshots as EML zip                                                                    |
| `listMailboxes()`                     | `atlas outlook list`       | List backed-up mailboxes                                                                           |
| `listSnapshots(mailboxId)`            | `atlas outlook list -m`    | List snapshots for a mailbox                                                                       |
| `readMessage(snapshotId, messageRef)` | `atlas outlook read`       | Read a single message                                                                              |
| `checkMailboxStatus(mailboxId)`       | `atlas outlook status`     | Fast delta peek (pending changes)                                                                  |
| `listAvailableMailboxes(options?)`    | _(discovery)_              | List all tenant mailboxes via Graph                                                                |
| `deleteMailboxData(mailboxId)`        | `atlas outlook delete -m`  | Delete all data for a mailbox                                                                      |
| `deleteSnapshot(snapshotId)`          | `atlas outlook delete -s`  | Delete a single snapshot manifest                                                                  |
| `purgeTenantData()`                   | `atlas delete --purge`     | Purge entire tenant bucket                                                                         |
| `getMailboxStats(mailboxId)`          | `atlas stats -m`           | Mailbox-level statistics                                                                           |

OneDrive and SharePoint expose parallel methods on `atlas.onedrive` and `atlas.sharepoint` (including workload-specific replication). See [OneDrive Backup](/onedrive-backup) and [SharePoint Backup](/sharepoint-backup) for full SDK examples per workload.

The drive restore methods take `destination`, `inPlace` and `renameTo` alongside `conflictBehavior`. As of 4.0.0 they default to a generated `Restore-<timestamp>` root rather than writing back over the original paths, so an embedder that relied on the old behaviour has to pass `inPlace: true`:

```typescript
const snapshotId = 'od-snap-123';
await atlas.onedrive.restore('owner-id', { snapshotId }); // /Restore-2026-08-27T10-15-30/...
await atlas.onedrive.restore('owner-id', { snapshotId, destination: '/DR-drill' });
await atlas.onedrive.restore('owner-id', { snapshotId, inPlace: true }); // pre-4.0.0 behaviour
```

`restore` and `save` on both drive workloads require an options object containing `snapshotId`. TypeScript enforces that at compile time; a JavaScript caller that omits it now gets a `TypeError` naming the method, for example `onedrive.restore() requires an options object with a snapshotId`, instead of a crash from inside the service about an internal property. `verify` continues to accept options optionally.

Deletion methods erase every version of the objects they match. `purgeTenantData()` sweeps the whole bucket, every workload and not only Outlook. The returned `DeletionResult` separates `retained*` (blocked by Object Lock, deletable once retention expires) from `failed*` (everything else, which will not clear on its own). See [Erasure](/security#erasure).

### Version restore

`restoreVersion()` pushes the file version bytes Atlas holds back into a live
drive or library. Available on both `atlas.onedrive` and `atlas.sharepoint`.

```typescript
// One exact version, listed first so you know what exists.
const versions = await atlas.onedrive.listFileVersions('owner-id', '/Documents/report.docx');
const previous = versions.at(-2);
if (!previous) throw new Error('No older version is stored for this file');

const result = await atlas.onedrive.restoreVersion('owner-id', {
  fileRef: '/Documents/report.docx',
  versionId: previous.versionId,
});

// A rollback of one folder to the state before a known instant.
await atlas.sharepoint.restoreVersion('site-id', {
  before: new Date('2026-03-10T00:00:00Z'),
  pathPrefix: '/Shared Documents/Projects',
  placement: 'in-place',
});
```

| Option       | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `fileRef`    | Graph item ID, rooted path, or bare filename; required with `versionId`          |
| `versionId`  | Exact stored version, from `listFileVersions()`                                  |
| `before`     | `Date`; restores each file's newest version at or before this instant            |
| `pathPrefix` | Limits a `before` rollback to one folder and below                               |
| `placement`  | `'copy'` (default) writes a sibling file; `'in-place'` uploads over the original |

Pass either `fileRef` with `versionId`, or `before`. The result reports
`filesRestored`, `filesSkipped`, the `placement` that was applied, and a
`restored` array of `{ fileId, versionId, lastModifiedAt, sizeBytes, restoredTo }`.
A file with no version stored at or before the cutoff appears in `errors` and
counts as skipped, so a caller can tell a complete rollback from a partial one:

```typescript
if (result.filesSkipped > 0) {
  for (const reason of result.errors) console.warn(reason);
}
```

Nothing is destroyed by either placement. `'copy'` never touches the live file.
`'in-place'` uploads over it, and Microsoft 365 records that as a new version
while keeping the content it replaced in the file's own version history.
Restored files carry the modification time the version had, not the restore
time.

Atlas uploads its own checksum-verified bytes rather than calling Graph's
`restoreVersion`, which only works on a version the service still holds and
cannot be verified against the manifest. See
[the CLI reference](/reference/cli#atlas-onedrive) for the full reasoning.

### Folder coverage

`backup()` walks every mail folder at any depth, including Drafts, Outbox, Junk Email, and folders Exchange marks hidden. Pass `excludeJunk` to skip Junk Email and its subfolders:

```typescript
const result = await atlas.outlook.backup('user@company.com', { excludeJunk: true });

for (const folder of result.summary.excludedFolders) {
  console.log(`${folder.folderPath} not captured: ${folder.reason}`);
}
```

`reason` is `'junk-excluded'`, `'hidden-system-folder'`,
`'recoverable-items-not-mail'` or `'recoverable-items-unrecognised'`. The same
list is on the manifest as `excludedFolders`, so an embedder can answer "was
this folder captured?" from a stored snapshot rather than from the options
whoever ran the backup happened to pass. `MailFolder.isHidden` marks folders
Exchange hides.

Drafts and Outbox are new in 4.1.0. Earlier versions skipped them, so the first
backup after upgrading is larger for mailboxes holding unsent mail.

#### Recoverable Items

`includeRecoverableItems` also captures hard-deleted and hold-retained mail
from the Exchange dumpster, which no delta page ever reports. Off by default:

```typescript
await atlas.outlook.backup('user@company.com', { includeRecoverableItems: true });
```

`Deletions`, `Purges`, `DiscoveryHolds` and `SubstrateHolds` are captured;
`Versions`, `Calendar Logging` and `Audits` are reported through
`excludedFolders` instead. Captured entries carry `recoverableItems: true` on
the manifest entry, and `restore()` and `save()` drop them unless the same
option is passed there:

```typescript
const restorable = manifest.entries.filter((entry) => entry.recoverableItems !== true);

await atlas.outlook.restore('snapshot-id', { includeRecoverableItems: true });
```

With the option off, request volume is identical to a run before it existed.
Storing purged mail has compliance consequences: see
[Recoverable Items and legal hold](/security#recoverable-items-and-legal-hold).

### Shared mailbox identity

Three result types carry an optional `mailboxPurpose` field (`'user' | 'linked' | 'shared' | 'room' | 'equipment' | 'others'`), sourced from the Graph `mailboxSettings.userPurpose` property. A value of `'shared'` identifies a shared mailbox:

- `TenantMailbox.mailboxPurpose` (from `listAvailableMailboxes()`; resolved only for unlicensed mailboxes during discovery)
- `MailboxSummary.mailboxPurpose` (from `listMailboxes()`; taken from the newest manifest that recorded one, so a transient lookup failure in the latest backup does not blank the field)
- `Manifest.mailboxPurpose` (from `backup()`, `listSnapshots()`, `getSnapshotDetail()`; recorded at backup time)

The field is absent when the purpose was never resolved (pre-feature manifests, lookup failures):

```typescript
const mailboxes = await atlas.outlook.listAvailableMailboxes();
const shared = mailboxes.filter((mb) => mb.mailboxPurpose === 'shared');
```

### In-Place Archive coverage

`TenantMailbox.hasInPlaceArchive` (from `listAvailableMailboxes()`) reports whether a mailbox has an In-Place Archive (Online Archive). That store is **not backed up**: Graph cannot read archive mailboxes at all, so a successful backup of such a mailbox is not a backup of all its mail. See [In-Place Archive is out of scope](/security#in-place-archive-is-out-of-scope).

The field is tri-state, and the third state matters:

```typescript
const mailboxes = await atlas.outlook.listAvailableMailboxes();

const uncovered = mailboxes.filter((mb) => mb.hasInPlaceArchive === true);
const unknown = mailboxes.filter((mb) => mb.hasInPlaceArchive === undefined);
```

`undefined` means unknown, not "no archive". The signal is the `Has Archive` column of the mailbox usage report, which needs the optional `Reports.Read.All` permission, so an embedder that treats absence as "covered" will report coverage Atlas never confirmed. No per-mailbox Graph property exposes archive state on v1.0 or beta.

### Drive item metadata

Drive manifest entries carry the metadata a restore cannot rebuild from bytes alone:

```typescript
const snapshot = await atlas.onedrive.getSnapshotDetail('owner-id', { snapshotId });

for (const entry of snapshot.entries) {
  entry.fileSystemInfo?.createdAt; // original client timestamp, restored
  entry.createdBy?.displayName; // author, recorded for audit only
  entry.lastModifiedBy?.email;
}
```

`fileSystemInfo` holds the client-reported timestamps from the Graph `fileSystemInfo` facet, which is the pair Atlas reapplies on restore. `lastModifiedAt` remains the service-side value, which after a restore reflects the restore. Authors and version authors are captured but never reapplied, and sharing permissions are not captured. See [What a drive restore rebuilds, and what it cannot](/security#what-a-drive-restore-rebuilds-and-what-it-cannot).

All four fields are absent on manifests written before 4.1.0.

### Identifier case

Every method taking a mailbox address, an Entra object ID, or a SharePoint site ID lowercases it before it becomes a storage key segment, so two spellings of one identifier address one tree.

The SDK is where this used to bite. Graph hands back these identifiers lowercase, so the CLI never saw the problem; an embedder holding an object ID in application state or reading one from a portal could. Two spellings meant two prefixes, so the same drive was backed up twice. Worse:

```typescript
// Before 2.1.0-beta: swept an empty prefix, reported what it deleted there,
// and left the real data behind -- a successful-looking erasure of nothing.
await atlas.onedrive.deleteOwnerData('75A21B57-4D82-4F42-9CCC-7C231C30F78C');
```

Graph **item** IDs (`fileId`, `itemId`) are case-sensitive and never folded. `fileFilter` compares them case-insensitively, so an ID copied from `listFileVersions()` matches whatever case you send it in.

## Save Options

`atlas.outlook.save` and `atlas.outlook.saveMailbox` accept the following options:

| Option               | Type      | Description                                               |
| -------------------- | --------- | --------------------------------------------------------- |
| `folderName`         | `string`  | Save only this folder and its subfolders (name or path)   |
| `messageRef`         | `string`  | Save a single message by index or ID                      |
| `startDate`          | `Date`    | Include snapshots on or after this date                   |
| `endDate`            | `Date`    | Include snapshots on or before this date                  |
| `outputPath`         | `string`  | Output zip file path (default: `Restore-<timestamp>.zip`) |
| `skipIntegrityCheck` | `boolean` | Skip SHA-256 verification (default: `false`)              |

Both methods return a `SaveResult`:

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

## Restore Options

`atlas.outlook.restore` and `atlas.outlook.restoreMailbox` accept the following options:

| Option          | Type     | Description                                                |
| --------------- | -------- | ---------------------------------------------------------- |
| `folderName`    | `string` | Restore only this folder and its subfolders (name or path) |
| `messageRef`    | `string` | Restore a single message by index or ID                    |
| `targetMailbox` | `string` | Target mailbox for cross-mailbox restore                   |
| `startDate`     | `Date`   | Include snapshots on or after this date                    |
| `endDate`       | `Date`   | Include snapshots on or before this date                   |

Both methods return a `RestoreResult`:

```typescript
interface RestoreResult {
  snapshotId: string;
  restoredCount: number;
  attachmentCount: number;
  errorCount: number;
  attachmentErrorCount: number;
  errors: string[];
  verificationWarnings: string[];
  restoreFolderName: string;
  graphCost?: OperationCost; // SDK only
  interrupted: boolean;
}
```

| Field                  | Description                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `errorCount`           | Message-level failures. Matches `errors.length`.                                            |
| `attachmentErrorCount` | Attachment-level failures (count only; details are logged during restore).                  |
| `errors`               | Human-readable detail for each message-level failure.                                       |
| `verificationWarnings` | Per-folder verification warnings, including API failures that prevented count confirmation. |

## Object Lock

Pass `objectLockRequest` to any backup method to apply WORM retention. Atlas derives the rest of the policy from it, so the SDK and the CLI produce the same result for the same retention period:

```typescript
await atlas.outlook.backup('user@company.com', {
  objectLockRequest: { mode: 'COMPLIANCE', retentionDays: 30 },
});

await atlas.onedrive.backup('owner-id', {
  objectLockRequest: { mode: 'GOVERNANCE', retentionDays: 30 },
});
```

| Field           | Derived behavior                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mode`          | `GOVERNANCE` (privileged users can shorten retention) or `COMPLIANCE` (nobody can, including root). Defaults to `GOVERNANCE`. |
| `retentionDays` | Converted to an absolute `retainUntil` timestamp in UTC at the moment the run starts.                                         |

Outlook applies the policy to each stored object; OneDrive and SharePoint set the bucket default retention so every new object version inherits it. Writes are fail-closed: when a lock policy is present and the bucket has versioning or Object Lock disabled, or does not support the requested mode, the write throws instead of storing unprotected data. Immutability is therefore never silently downgraded.

## Batch Processing

For backing up multiple mailboxes from a shell, enumerate them with `atlas outlook mailboxes` and loop over `atlas outlook backup -m <id>` in your scheduler. The CLI backs up one mailbox per invocation; fan-out is scheduling and belongs to the caller.

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

// Query replication status: by snapshot, or every snapshot for one owner
const status = await atlas.getReplicationStatus('snapshot-id');
const ownerStatus = await atlas.getReplicationStatusByOwner('user@company.com');

// Disaster recovery: recover from a replica
await atlas.rehydrateSnapshot('snapshot-id', offsite);
await atlas.rehydrateMailbox('user@company.com', offsite);

// Full tenant DR: every workload, reported per workload
const recovery = await atlas.rehydrateTenant(offsite);
for (const { workload, result } of recovery.workloads) {
  console.log(workload, result.objectsCopied, result.objectsFailed);
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

The four operations that report cost, `backup`, `restore`, `restoreMailbox` and `checkMailboxStatus`, return how many Graph API requests they made, broken down by service pool, as a `graphCost` field on the result. Other Graph-backed calls such as `listAvailableMailboxes()` do consume quota but do not carry the field, so a scheduler budgeting against `graphCost` should account for them separately:

```typescript
const result = await atlas.outlook.backup('user@company.com');

console.log(result.graphCost);
// {
//   requestsTotal: 852,
//   byService: {
//     outlook: { requests: 847, resourceUnits: 847, uploadBytes: 0 },
//     identity: { requests: 5, resourceUnits: 5, uploadBytes: 0 },
//   },
//   requestsByType: {
//     // Keys are request-type labels, not fields: they stay exactly as Atlas records them.
//     delta_sync: 312, fetch_attachments: 530,
//     list_folders: 5, mailbox_exists: 2, list_users: 3,
//   },
//   elapsedMs: 45200,
// }
```

Methods that report `graphCost`: `atlas.outlook.backup`, `atlas.outlook.restore`, `atlas.outlook.restoreMailbox`, `atlas.outlook.checkMailboxStatus`.

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

`requestsByType` labels each request with the connector operation that issued
it, so a paginated `delta_sync` shows the page count under one label. Those
labels are map keys rather than fields and are recorded verbatim, so they keep
the spelling shown in the example above.

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
  recordCost(result.graphCost);
} catch (err) {
  // Requests already burned before the failure -- undefined if the error came
  // from somewhere other than a tracked SDK operation.
  const cost = getGraphCost(err);
  if (cost) recordCost(cost);
  throw err;
}
```

The error itself is rethrown unchanged, so `instanceof` checks and existing catch
filters keep working, and the cost is a non-enumerable property, so error logging
and serialisation are unaffected. A failure that happened before any Graph call
reports `requestsTotal: 0`, which is a fact worth recording rather than a missing value.

::: warning Ignoring this skews your scheduling in the wrong direction
A scheduler that reads cost only on the success path treats the most expensive
runs as free, and re-queues the next mailbox into a tenant that is already
throttled, producing another 429 and raising the throttle fence again.
:::

### OperationCost Type

```typescript
interface OperationCost {
  requestsTotal: number;
  byService: Partial<Record<GraphServicePool, ServicePoolCost>>;
  requestsByType: Record<string, number>;
  elapsedMs: number;
}

interface ServicePoolCost {
  requests: number; // API calls made against this pool
  resourceUnits: number; // RU consumed (equals requests for flat-cost Outlook pool)
  uploadBytes: number; // Request body bytes (relevant for Outlook 150 MB/5min limit)
}

type GraphServicePool = 'outlook' | 'sharepoint_onedrive' | 'identity';
```

Only pools that were actually used during the operation appear as keys in `byService`. A mail backup typically has `outlook` and `identity` entries.

### GRAPH_SERVICE_LIMITS

The officially-sourced throttling limits are exported as a frozen constant so your scheduler can use the same numbers Atlas uses internally:

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
// identity.usersListCost               => 2
```

See the [Graph API Rate Limits](/operations/graph-rate-limits) page for the full reference including all pool limits, cost models, and official Microsoft documentation links.

### Scheduling with pg-boss

A common pattern for SaaS products is to queue one job per mailbox using pg-boss and use `graphCost` to compute a cooldown before scheduling the next job:

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
    // A failed run has usually burned MORE quota than a successful one. Bill it
    // and cool down on it, then let pg-boss see the failure.
    cost = getGraphCost(err);
    throw err;
  } finally {
    if (cost) {
      // Store per-pool costs for trend analysis
      await db.query(
        `INSERT INTO backupCosts
           (mailboxId, outlookRequests, identityRequests, elapsedMs, completedAt)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          mailboxId,
          cost.byService.outlook?.requests ?? 0,
          cost.byService.identity?.requests ?? 0,
          cost.elapsedMs,
        ],
      );

      // Compute cooldown from the Outlook pool limit (bottleneck for mail backup)
      const outlookLimits = GRAPH_SERVICE_LIMITS.outlook;
      const outlookUsed = cost.byService.outlook?.requests ?? 0;
      const usageRatio = outlookUsed / outlookLimits.requestsPerWindow;
      const cooldownMs = Math.ceil(usageRatio * outlookLimits.windowDurationMs);

      // Re-enqueue after cooldown -- on the failure path this is what stops the
      // retry from landing straight back on a throttled tenant.
      // `retryLimit: 0` because this is the retry: pg-boss would otherwise schedule its own
      // automatic retry alongside this cooldown job, and the tenant would be hit twice.
      await boss.send('backup-mailbox', job.data, {
        startAfter: new Date(Date.now() + cooldownMs),
        retryLimit: 0,
      });
    }
  }
});
```

Because the Outlook pool limit is per-mailbox, each mailbox's cooldown is independent. Running 50 parallel pg-boss workers for 50 different mailboxes is safe, because they do not share quota.

For OneDrive backup jobs, the `sharepoint_onedrive` pool is per-tenant instead. Aggregate `resourceUnits` across all users of a tenant and compare against `GRAPH_SERVICE_LIMITS.sharepoint_onedrive.resourceUnitsPerMinute['<tier>']` before scheduling the next OneDrive job.

## Errors

Every failure Atlas raises on purpose is an `AtlasError` with a stable `code`. Branch on the class or on the code, never on the message: message wording changes between releases and is written for the operator reading a terminal, not for a caller.

```typescript
import { MailboxNotLicensedError, WrongPassphraseError, AtlasError } from '@wisecom/atlas-sdk';

try {
  await atlas.outlook.backup('user@company.com');
} catch (err) {
  if (err instanceof MailboxNotLicensedError) {
    await reassign_license('user@company.com'); // retryable once a license is back
  } else if (err instanceof WrongPassphraseError) {
    throw err; // never retry: the data is fine, the key is wrong
  } else if (err instanceof AtlasError) {
    logger.error({ code: err.code, cause: err.cause }, 'Atlas backup failed');
  }
}
```

| Class                               | `code`                       | Meaning                                                                       |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `AtlasError`                        | any of the below             | Base class; catch this to separate deliberate failures from bugs              |
| `AuthError`                         | `ATLAS_AUTH_DENIED`          | Graph or storage refused the call for lack of permission or admin consent     |
| `MailboxNotLicensedError`           | `ATLAS_MAILBOX_NOT_LICENSED` | No Exchange Online license, so Graph will not serve the mailbox               |
| `NotFoundError`                     | `ATLAS_NOT_FOUND`            | Snapshot, mailbox, drive, site or object does not exist                       |
| `ThrottledError`                    | `ATLAS_THROTTLED`            | Service throttled the call and the retry budget was spent; see `retryAfterMs` |
| `WrongPassphraseError`              | `ATLAS_WRONG_PASSPHRASE`     | The passphrase could not unwrap the data key                                  |
| `ObjectLockRetainedError`           | `ATLAS_OBJECT_LOCK_RETAINED` | Object is under retention or a legal hold; `key` names it                     |
| `StorageError`                      | `ATLAS_STORAGE_FAILURE`      | Storage failed for a reason that is not permission, retention or absence      |
| `ConfigError`                       | `ATLAS_CONFIG_INVALID`       | Credentials, endpoint, passphrase or tenant is missing or unusable            |
| `ObjectLockVersioningDisabledError` | `ATLAS_CONFIG_INVALID`       | Immutability requested but bucket versioning is off                           |
| `ObjectLockUnsupportedError`        | `ATLAS_CONFIG_INVALID`       | Immutability requested but the bucket has no Object Lock                      |
| `ObjectLockModeRejectedError`       | `ATLAS_CONFIG_INVALID`       | Backend rejected the requested retention mode                                 |
| `PreconditionFailedError`           | `ATLAS_STORAGE_FAILURE`      | Conditional write lost a race (HTTP 412)                                      |

Every error carries the underlying failure as `cause`, so the Graph or AWS SDK error is still available for logging without being what you branch on.

`WrongPassphraseError` deserves a note. AES-GCM cannot tell a wrong key from damaged ciphertext: both are one authentication failure. Atlas names the passphrase because that is the likelier cause and the only one an operator can act on, and keeps the raw crypto error as `cause`. If the passphrase is definitely correct for that tenant, treat it as a possible integrity problem and run `atlas verify` against the snapshot.

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
- Error classes: `AtlasError`, `AtlasErrorCode`, `AuthError`, `MailboxNotLicensedError`, `NotFoundError`, `ThrottledError`, `WrongPassphraseError`, `ObjectLockRetainedError`, `StorageError`, `ConfigError`, `ObjectLockVersioningDisabledError`, `ObjectLockUnsupportedError`, `ObjectLockModeRejectedError`, `PreconditionFailedError` (see [Errors](#errors))

**Graph cost types:**

| Export                    | Kind  | Description                                                                 |
| ------------------------- | ----- | --------------------------------------------------------------------------- |
| `OperationCost`           | type  | Per-operation cost breakdown                                                |
| `ServicePoolCost`         | type  | Cost for a single service pool                                              |
| `GraphServicePool`        | type  | Pool identifier union type                                                  |
| `GraphServiceLimits`      | type  | Type for the full limits constant                                           |
| `OutlookServiceLimits`    | type  | Outlook pool limits type                                                    |
| `SharePointServiceLimits` | type  | SharePoint/OneDrive pool limits type                                        |
| `IdentityServiceLimits`   | type  | Identity pool limits type                                                   |
| `GRAPH_SERVICE_LIMITS`    | value | Frozen official limits constant                                             |
| `getGraphCost`            | value | Reads the cost burned before a failed operation threw                       |
| `SyncResult`              | type  | Result of `atlas.outlook.backup` (includes `graphCost`)                     |
| `RestoreResult`           | type  | Result of `atlas.outlook.restore` / `restoreMailbox` (includes `graphCost`) |
