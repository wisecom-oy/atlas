---
description: 'Node.js SDK recipes for scheduled jobs and services: conditional backups, failure handling, discovery, exports, verification, and metrics.'
---

# SDK examples

Recipes for embedding Atlas in a Node.js job or service. Each one names the task, says when you would use it, and gives code you can adapt. Method signatures and result fields are listed in the [SDK reference](/reference/sdk).

For code that runs in a browser or a Worker, such as an onboarding form or a Microsoft 365 inventory, see [Browser and Worker examples](/reference/contract-examples).

## Setup

Every recipe below uses an `atlas` instance created like this. See [createAtlasInstance](/reference/sdk#instance-lifecycle) for every option.

```ts
import { createAtlasInstance } from '@wisecom/atlas-sdk';
import type { AtlasInstance } from '@wisecom/atlas-sdk';

const atlas: AtlasInstance = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});
```

::: warning Run backups one at a time
Process tenants and mailboxes sequentially, not with `Promise.all`. Each backup makes many Microsoft Graph calls, and parallel runs get throttled (HTTP 429) and back off, which makes the whole job slower. See [Graph rate limits](/operations/graph-rate-limits).
:::

## Backup

### Back up only mailboxes that changed

Use this on a frequent schedule, so mailboxes with nothing new cost no backup run.

```ts
const mailboxes = ['ceo@example.com', 'finance@example.com', 'legal@example.com'];

for (const mailbox of mailboxes) {
  const status = await atlas.outlook.checkMailboxStatus(mailbox);

  if (status.isUpToDate) {
    console.log(`[skip] ${mailbox}: no changes since last backup`);
    continue;
  }

  console.log(
    `[backup] ${mailbox}: ${status.totalPendingChanges} pending change(s) across ${status.totalFolders} folder(s)`,
  );

  const result = await atlas.outlook.backup(mailbox);

  console.log(
    `[done] ${mailbox}: snapshot ${result.snapshot.id}, ` +
      `${result.summary.stored} stored, ${result.summary.deduplicated} deduplicated, ` +
      `${result.summary.attachmentsStored} attachments (${result.summary.elapsedMs} ms)`,
  );
}
```

`checkMailboxStatus` does not move the sync checkpoint, so the `backup` call that follows still picks up every pending change.

### Nightly backup job that alerts on failure

Use this under cron, systemd, or an orchestrator, so a failed or partial run produces a non-zero exit code.

```ts
interface BackupReport {
  mailbox: string;
  snapshotId: string;
  stored: number;
  deduplicated: number;
  attachments: number;
  elapsedMs: number;
}

async function run_nightly_backup(atlas: AtlasInstance, mailboxes: string[]) {
  const succeeded: BackupReport[] = [];
  const failed: { mailbox: string; error: string }[] = [];

  for (const mailbox of mailboxes) {
    try {
      const status = await atlas.outlook.checkMailboxStatus(mailbox);

      if (status.isUpToDate) {
        console.log(`[skip] ${mailbox}: already current`);
        continue;
      }

      const result = await atlas.outlook.backup(mailbox);
      const { summary } = result;

      // A partial run is a failure, so the job alerts instead of reporting success.
      if (summary.interrupted || summary.folderErrors.length > 0) {
        const reason = summary.interrupted
          ? `interrupted at ${summary.completedFolderCount}/${summary.totalFolderCount} folders`
          : `${summary.folderErrors.length} folder error(s): ${summary.folderErrors.join(', ')}`;
        failed.push({ mailbox, error: reason });
        console.error(`[fail] ${mailbox}: ${reason}`);
        continue;
      }

      succeeded.push({
        mailbox,
        snapshotId: result.snapshot.id,
        stored: summary.stored,
        deduplicated: summary.deduplicated,
        attachments: summary.attachmentsStored,
        elapsedMs: summary.elapsedMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ mailbox, error: message });
      console.error(`[fail] ${mailbox}: ${message}`);
    }
  }

  console.log(`\nBackup complete: ${succeeded.length} succeeded, ${failed.length} failed`);
  return { succeeded, failed };
}

const { failed } = await run_nightly_backup(atlas, [
  'alice@example.com',
  'bob@example.com',
  'carol@example.com',
]);
process.exit(failed.length > 0 ? 1 : 0);
```

Cron turns the non-zero exit into an alert email, systemd records a failed unit, and a CI/CD pipeline fails the step. An interrupted run or one with folder errors counts as a failure.

### Back up and send a report

Use this when results must go to a webhook, a database row, a structured log, or an email.

```ts
interface MailboxReport {
  mailbox: string;
  snapshotId?: string;
  stored?: number;
  ok: boolean;
  error?: string;
}

const results: MailboxReport[] = [];

for (const mailbox of ['ceo@example.com', 'finance@example.com', 'legal@example.com']) {
  try {
    const backup = await atlas.outlook.backup(mailbox);
    results.push({
      mailbox,
      snapshotId: backup.snapshot.id,
      stored: backup.summary.stored,
      ok: !backup.summary.interrupted && backup.summary.folderErrors.length === 0,
    });
  } catch (err) {
    results.push({ mailbox, ok: false, error: (err as Error).message });
  }
}

// Send results wherever your reporting needs them.
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
```

An offsite copy for a 3-2-1 strategy comes from your storage provider's replication, not from this job. See [Replica setup](/self-hosting/replication).

### Back up OneDrive and SharePoint only when they changed

Use this to skip drive owners and sites with nothing new.

```ts
// OneDrive
const odStatus = await atlas.onedrive.checkStatus('owner-id');

if (odStatus.isUpToDate) {
  console.log('[skip] OneDrive is current');
} else {
  console.log(
    `[backup] ${odStatus.totalPendingChanges} pending change(s), ` +
      `${odStatus.totalFailedItems} failed item(s) across ${odStatus.totalDrives} drive(s)`,
  );
  await atlas.onedrive.backup('owner-id');
}

// SharePoint
const spStatus = await atlas.sharepoint.checkStatus('site-id');

if (spStatus.isUpToDate) {
  console.log('[skip] SharePoint site is current');
} else {
  console.log(
    `[backup] ${spStatus.totalPendingChanges} pending change(s), ` +
      `${spStatus.totalFailedItems} failed item(s) across ${spStatus.totalLibraries} library/libraries`,
  );
  await atlas.sharepoint.backup('site-id');
}
```

A drive or site with files that failed in an earlier run is never reported as up to date, so this check does not skip it.

### Back up several tenants

Use this when one service, such as a managed service provider's, backs up many tenants.

```ts
interface TenantConfig {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  encryptionPassphrase: string;
  mailboxes: string[];
}

async function backup_all_tenants(
  tenants: TenantConfig[],
  shared_s3: { endpoint: string; accessKey: string; secretKey: string },
) {
  for (const tenant of tenants) {
    console.log(`\nTenant: ${tenant.name} (${tenant.tenantId})`);

    await using atlas = createAtlasInstance({
      tenantId: tenant.tenantId,
      clientId: tenant.clientId,
      clientSecret: tenant.clientSecret,
      s3Endpoint: shared_s3.endpoint,
      s3AccessKey: shared_s3.accessKey,
      s3SecretKey: shared_s3.secretKey,
      encryptionPassphrase: tenant.encryptionPassphrase,
    });

    for (const mailbox of tenant.mailboxes) {
      try {
        const result = await atlas.outlook.backup(mailbox);
        console.log(`  [done] ${mailbox}: ${result.summary.stored} stored`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [fail] ${mailbox}: ${message}`);
      }
    }
  }
}
```

Create one instance per tenant. Each tenant gets its own bucket, its own wrapped data key, and its own passphrase, so tenant data is never mixed and a leaked passphrase exposes one tenant, not all of them. `await using` releases the instance's storage connections at the end of each tenant's block.

### Restore into another tenant

Use this to restore a mailbox backed up in one tenant into a mailbox in a different tenant.

```ts
import { createTenant, AuthError } from '@wisecom/atlas-sdk';

// `atlas` belongs to the source tenant: it reads and decrypts the backup.
const destination = createTenant({
  tenantId: process.env.FABRIKAM_TENANT_ID!,
  clientId: process.env.FABRIKAM_CLIENT_ID!,
  clientSecret: process.env.FABRIKAM_CLIENT_SECRET!,
});

// Fail before the restore starts if the destination secret was revoked.
try {
  await destination.validate();
} catch (err) {
  if (err instanceof AuthError) throw new Error('Destination app credentials were refused');
  throw err;
}

const result = await atlas.outlook.restore('snapshot-id', {
  targetMailbox: 'user@example.com',
  targetTenant: destination,
});
console.log(`${result.restoredCount} restored, ${result.errorCount} failed`);
```

The target mailbox must exist and hold an Exchange Online license in the destination tenant, and the destination app needs `Mail.ReadWrite`. See [Cross-tenant restore](/reference/sdk#cross-tenant-restore).

## Discovery and pre-flight checks

### Check the bucket before the first immutable backup

Use this before the first backup with Object Lock, so a misconfigured bucket fails before any data is written.

```ts
async function validate_immutable_readiness(atlas: AtlasInstance) {
  const check = await atlas.checkStorage({
    mode: 'GOVERNANCE',
    retentionDays: 30,
  });

  console.log('Storage check results:');
  console.log(`  Reachable:        ${check.reachable}`);
  console.log(`  Versioning:       ${check.versioningEnabled}`);
  console.log(`  Object Lock:      ${check.objectLockEnabled}`);
  console.log(`  Mode supported:   ${check.modeSupported}`);

  if (
    !check.reachable ||
    !check.versioningEnabled ||
    !check.objectLockEnabled ||
    !check.modeSupported
  ) {
    throw new Error(
      'Storage is not ready for immutable backups. ' +
        'Ensure the bucket exists with versioning and Object Lock enabled, and that the requested mode is supported.',
    );
  }

  console.log('Storage is ready for immutable backups.');
}
```

### Find mailboxes and look up users

Use this for onboarding, audit dashboards, or provisioning, and to find mailboxes that have no backup yet.

```ts
// Every tenant mailbox (licensed users and shared mailboxes)
const mailboxes = await atlas.outlook.listAvailableMailboxes();

console.log(`Found ${mailboxes.length} mailboxes:`);
for (const mb of mailboxes) {
  if (mb.mailboxPurpose === 'shared') {
    console.log(`  ${mb.mail}: ${mb.displayName} (shared mailbox)`);
  } else {
    console.log(
      `  ${mb.mail}: ${mb.displayName} (${mb.hasExchangeLicense ? 'licensed' : 'unlicensed'})`,
    );
  }
}

// Look up a user's Microsoft Entra object ID from an address
const user = await atlas.resolveUser('alice@example.com');
console.log(`Resolved: ${user.displayName} → ${user.objectId}`);

// Users seen by previous backups (the identity registry)
const registry = await atlas.listUsers();
if (registry) {
  for (const entry of registry.entries) {
    console.log(`  ${entry.email}: registered ${entry.registeredAt} (${entry.status})`);
  }
}
```

`listAvailableMailboxes` asks Microsoft 365, so it returns every mailbox in the tenant. `atlas.outlook.listMailboxes()` returns only mailboxes that have a backup. The difference between the two is the set of mailboxes not yet protected.

### Find SharePoint sites

Use this when nobody maintains the site inventory by hand.

```ts
// Every site
const sites = await atlas.sharepoint.listSites();
for (const site of sites) {
  console.log(`${site.displayName}: ${site.siteUrl}`);
}

// Look up a site's ID from its URL
const site = await atlas.sharepoint.resolveSite('https://contoso.sharepoint.com/sites/Engineering');
console.log(`Site ID: ${site.siteId}`);

// Back up the site and every subsite beneath it (one result per site, root first)
const results = await atlas.sharepoint.backup(site.siteId, { includeSubsites: true });
```

## Export and compliance

### Export a mailbox to a ZIP file on a schedule

Use this for legal holds, compliance audits, or a copy for a departing employee.

```ts
async function export_mailbox_archive(atlas: AtlasInstance, mailbox: string, output_dir: string) {
  const timestamp = new Date().toISOString().slice(0, 10);
  const outputPath = `${output_dir}/${mailbox.replace('@', '_at_')}_${timestamp}.zip`;

  const result = await atlas.outlook.saveMailbox(mailbox, {
    outputPath,
    skipIntegrityCheck: false,
  });

  console.log(
    `[export] ${mailbox}: ${result.savedCount} messages, ` +
      `${result.attachmentCount} attachments, ` +
      `${(result.totalBytes / 1024 ** 2).toFixed(1)} MB → ${result.outputPath}`,
  );

  if (result.integrityFailures.length > 0) {
    console.warn(`[warn] ${result.integrityFailures.length} integrity failure(s) during export`);
  }

  return result;
}
```

### Stream an export over HTTP

Use this to give users a download of their own mailbox without staging the archive on the server. The archive streams to the response as it is built, so a read-only or ephemeral filesystem works and disk use does not grow with mailbox size.

```ts
import express from 'express';

const app = express();

// require_authenticated_user is your own session middleware.
app.get('/exports/my-mailbox', require_authenticated_user, async (req, res) => {
  const mailbox = req.user.mailbox; // resolved from the session and tenant-checked
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${mailbox}.zip"`);

  try {
    const result = await atlas.outlook.saveMailbox(mailbox, { output: res });
    console.log(`[export] ${result.savedCount} messages, ${result.totalBytes} bytes`);

    if (result.integrityFailures.length > 0) {
      // The client already has the bytes, so record the failure instead of retracting it.
      console.warn(`[warn] ${result.integrityFailures.length} integrity failure(s)`);
    }
  } catch (err) {
    // Atlas destroys the response once the export starts. Earlier failures, such as resolving the mailbox, leave it open.
    console.error('[export] failed', err);
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
    } else {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.status(500).end();
    }
  }
});
```

::: danger Take the mailbox from the session, never from the request
Atlas authenticates as an application with tenant-wide access and cannot tell whose request it is serving. A mailbox taken from a route parameter or query string lets any caller export any mailbox in the tenant.
:::

How the stream ends:

| Situation | What the client receives |
| --- | --- |
| Export completes | A complete archive. `outputPath` in the result is empty, because nothing is written to disk |
| Mailbox has no messages | A valid, empty archive |
| Run fails or is interrupted after it starts | A destroyed stream, so the client can tell the file is incomplete |
| Failure before the export starts, such as a failed identity lookup | Nothing. The response is untouched and your handler must end it, as the example does |

OneDrive and SharePoint take the same option: `atlas.onedrive.save(ownerId, { snapshotId, output: res })`.

## Maintenance and monitoring

### Verify the latest backup of each mailbox

Use this as a scheduled integrity check. It is the SDK equivalent of `atlas outlook verify`.

```ts
async function verify_recent_backups(atlas: AtlasInstance, mailboxes: string[]) {
  for (const mailbox of mailboxes) {
    const snapshots = await atlas.outlook.listSnapshots(mailbox);

    if (snapshots.length === 0) {
      console.log(`[skip] ${mailbox}: no snapshots`);
      continue;
    }

    // listSnapshots returns newest first.
    const latest = snapshots[0];
    const result = await atlas.outlook.verify(latest.snapshotId);
    const problems = result.failed.length + result.unverifiable.length;

    if (problems === 0 && !result.interrupted) {
      console.log(`[pass] ${mailbox}: ${result.passed}/${result.totalChecked} objects verified`);
    } else {
      console.error(
        `[FAIL] ${mailbox}: ${result.failed.length} integrity failure(s), ` +
          `${result.unverifiable.length} unverifiable, interrupted: ${result.interrupted}`,
      );
      for (const item of [...result.failed, ...result.unverifiable]) {
        console.error(`  - ${item}`);
      }
    }
  }
}
```

Verification downloads and decrypts every object, which checks its AES-GCM authentication tag, then compares the SHA-256 of the content with the one recorded in the snapshot.

| Result field | Meaning |
| --- | --- |
| `failed` | The object is corrupted or was altered |
| `unverifiable` | No copy of the object was stored, so it cannot be checked or restored |
| `interrupted` | The run stopped early. Never treat it as a pass |

### Export storage metrics

Use this to feed Prometheus, Datadog, Grafana, or your own dashboard.

```ts
async function collect_storage_metrics(atlas: AtlasInstance) {
  const stats = await atlas.getBucketStats();

  const metrics = {
    tenantId: stats.tenantId,
    totalMailboxes: stats.mailboxCount,
    totalSnapshots: stats.snapshotCount,
    totalMessages: stats.totalMessages,
    totalSizeGb: (stats.totalSizeBytes / 1024 ** 3).toFixed(2),
    totalAttachments: stats.attachmentCount,
    attachmentSizeGb: (stats.attachmentSizeBytes / 1024 ** 3).toFixed(2),
  };

  console.log(JSON.stringify(metrics, null, 2));
  return metrics;
}
```

For a per-mailbox breakdown:

```ts
async function collect_mailbox_metrics(atlas: AtlasInstance, mailbox: string) {
  const stats = await atlas.outlook.getMailboxStats(mailbox);

  return {
    mailbox,
    snapshots: stats.snapshotCount,
    messages: stats.totalMessages,
    sizeMb: (stats.totalSizeBytes / 1024 ** 2).toFixed(1),
    attachments: stats.attachmentCount,
    folders: stats.folders.map((f) => ({
      id: f.folderId,
      messages: f.messageCount,
      sizeMb: (f.totalSizeBytes / 1024 ** 2).toFixed(1),
    })),
  };
}
```

### Remove old backups

Keep 90 days of history per owner. Run it after the owner's backup, since both take the owner lease:

```ts
import { OwnerBusyError } from '@wisecom/atlas-sdk';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function pruneMailbox(mailbox: string): Promise<void> {
  const before = new Date(Date.now() - RETENTION_MS);
  try {
    const result = await atlas.outlook.pruneSnapshots(mailbox, { before });
    if (result.retainedManifestKeys.length > 0 || result.contentSweepSkipped) {
      console.warn(`Prune of ${mailbox} left data behind; the next run retries it`);
    }
  } catch (err) {
    if (!(err instanceof OwnerBusyError)) throw err;
    // Another operation holds the mailbox; try again on the next schedule.
  }
}
```

`onedrive.pruneSnapshots(ownerId, options)` and `sharepoint.pruneSnapshots(siteId, options)` work the same way. The oldest kept snapshot absorbs the older history, so every newer snapshot still restores. Pass `dryRun: true` to see the snapshots, object versions, and bytes a run would remove. See [Snapshot retention](/operations/retention).

To remove all of an owner's data instead:

```ts
await atlas.outlook.deleteMailboxData('user@example.com');
await atlas.onedrive.deleteOwnerData('owner-id');
await atlas.sharepoint.deleteSiteData('site-id');
```

::: danger Deletion is permanent
These calls remove every snapshot of the owner. Objects still under Object Lock retention are kept until it expires. See [Immutability](/operations/immutability).
:::
