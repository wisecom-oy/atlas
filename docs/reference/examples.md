---
description: 'Node.js SDK examples for embedding Atlas in scheduled jobs and services: conditional backups, status checks, and handling the failures a run will hit.'
---

# SDK examples

Patterns for embedding Atlas in a Node.js application. Each example uses the SDK return types and shows how to handle the failures a scheduled job will hit. Configuration follows [createAtlasInstance](/reference/sdk#instance-lifecycle).

## Backup

### Conditional backup: check status first

Check which mailboxes have pending changes before starting a backup. Mailboxes with no changes are skipped, which avoids unnecessary Graph API calls on scheduled runs.

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const mailboxes = ['ceo@company.com', 'finance@company.com', 'legal@company.com'];

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

`checkMailboxStatus` reads the Graph delta for each folder without saving the new cursor, so the following `backup` call still starts from the last sync point.

### Nightly backup job with error handling

Back up every mailbox, collect the results, and exit with a code that the process manager can act on (cron, systemd, or an orchestration platform).

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';
import type { AtlasInstance } from '@wisecom/atlas-sdk';

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

// Entry point

const atlas = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const mailboxes = ['alice@company.com', 'bob@company.com', 'carol@company.com'];

const { failed } = await run_nightly_backup(atlas, mailboxes);
process.exit(failed.length > 0 ? 1 : 0);
```

A non-zero exit code is what cron turns into an alert email, systemd records as a failed unit, and a CI/CD pipeline treats as a failed step. A partial run (interrupted, or with folder errors) counts as a failure, so it alerts the same way.

### Backup, replicate, and report

Back up each mailbox, replicate the snapshot to an offsite target, and collect the results. This is the core loop for a 3-2-1 strategy. Adapt the reporting to your stack: a webhook, a database row, a structured log, or an email.

```typescript
import { createAtlasInstance, createStorageTarget } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const offsite = createStorageTarget({
  s3Endpoint: process.env.OFFSITE_S3_ENDPOINT!,
  s3AccessKey: process.env.OFFSITE_S3_ACCESS_KEY!,
  s3SecretKey: process.env.OFFSITE_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const mailboxes = ['ceo@company.com', 'finance@company.com', 'legal@company.com'];

interface MailboxReport {
  mailbox: string;
  snapshotId?: string;
  stored?: number;
  ok: boolean;
  error?: string;
}

const results: MailboxReport[] = [];
const replications: Promise<void>[] = [];

for (const mailbox of mailboxes) {
  try {
    const backup = await atlas.outlook.backup(mailbox);
    const report: MailboxReport = {
      mailbox,
      snapshotId: backup.snapshot.id,
      stored: backup.summary.stored,
      ok: !backup.summary.interrupted && backup.summary.folderErrors.length === 0,
    };
    results.push(report);

    // Replication is S3-to-S3 only and makes no Graph API calls, so it runs
    // in the background while the next mailbox backs up. The handlers never
    // reject: an unobserved rejection would crash the job mid-backup.
    replications.push(
      atlas.replicateSnapshot(backup.snapshot.id, [offsite]).then(
        (copies) => {
          if (copies.some((copy) => copy.status !== 'COMPLETED')) {
            report.ok = false;
            report.error = 'offsite copy incomplete';
          }
        },
        (err) => {
          report.ok = false;
          report.error = (err as Error).message;
        },
      ),
    );
  } catch (err) {
    results.push({ mailbox, ok: false, error: (err as Error).message });
  }
}

await Promise.all(replications);

// Send results wherever your reporting needs them.
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
```

Backups run one after another to stay within Graph limits. Each replication starts as soon as its snapshot exists, without blocking the next backup. `Promise.all` waits until every replication has finished. A copy that ends `PARTIAL` or `FAILED` resolves rather than throws, so each handler records the outcome and never rejects.

If the process crashes partway through, `replicateSnapshot` does not retry snapshots it was not given. Run `atlas.replicateMailbox(mailbox, [offsite])` for each mailbox on the next run. It copies every snapshot the target lacks.

### OneDrive and SharePoint status check

Check for pending changes before a OneDrive or SharePoint backup. Scheduled jobs then skip owners and sites with no changes.

```typescript
// OneDrive status check
const odStatus = await atlas.onedrive.checkStatus('owner-id');

if (odStatus.isUpToDate) {
  console.log('[skip] OneDrive is current');
} else {
  console.log(
    `[backup] ${odStatus.totalPendingChanges} pending changes across ${odStatus.totalDrives} drive(s)`,
  );
  await atlas.onedrive.backup('owner-id');
}

// SharePoint status check
const spStatus = await atlas.sharepoint.checkStatus('site-id');

if (spStatus.isUpToDate) {
  console.log('[skip] SharePoint site is current');
} else {
  console.log(
    `[backup] ${spStatus.totalPendingChanges} pending changes across ${spStatus.totalLibraries} library/libraries`,
  );
  await atlas.sharepoint.backup('site-id');
}
```

### Multi-tenant backup

A managed service provider creates one Atlas instance per tenant. Each tenant has its own S3 bucket, its own wrapped data key, and its own encryption passphrase, so one tenant's data is never mixed with another's, and a leaked passphrase exposes one tenant rather than all of them. The `await using` declaration releases the instance's storage connections at the end of each tenant's block.

```typescript
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
    console.log(`\n--- Tenant: ${tenant.name} (${tenant.tenantId}) ---`);

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

::: warning Run tenants and mailboxes sequentially
Process tenants and mailboxes one at a time, not with `Promise.all`. Each mailbox backup makes many Microsoft Graph API calls. Running them in parallel triggers HTTP 429 throttling and exponential backoff, which makes the total runtime longer.
:::

## Discovery and pre-flight checks

### Pre-flight storage validation

Verify the bucket is configured correctly before the first immutable backup writes data.

```typescript
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

### Mailbox discovery and identity resolution

Discover tenant mailboxes and resolve user identities before running backups. Use this as the basis for onboarding workflows, audit dashboards, and provisioning.

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({/* config */});

// Discover all tenant mailboxes (licensed users and shared mailboxes)
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

// Resolve a user email to their Entra object ID
const user = await atlas.resolveUser('alice@company.com');
console.log(`Resolved: ${user.displayName} → ${user.objectId}`);

// List the identity registry (users seen by previous backups)
const registry = await atlas.listUsers();
if (registry) {
  for (const entry of registry.entries) {
    console.log(`  ${entry.email}: registered ${entry.registeredAt} (${entry.status})`);
  }
}
```

`listAvailableMailboxes` queries Microsoft Graph directly, so it returns every tenant mailbox whether or not it has been backed up. Compare it with `atlas.outlook.listMailboxes()`, which returns only mailboxes that have a backup in the catalog, to find mailboxes that are not yet protected.

### SharePoint site discovery

Discover SharePoint sites and resolve site URLs before running backups, for environments where the site inventory is not maintained by hand.

```typescript
// Discover all sites
const sites = await atlas.sharepoint.listSites();
for (const site of sites) {
  console.log(`${site.displayName}: ${site.siteUrl}`);
}

// Resolve a site URL to its Graph site ID
const site = await atlas.sharepoint.resolveSite('https://contoso.sharepoint.com/sites/Engineering');
console.log(`Site ID: ${site.siteId}`);

// Back up the resolved site and every subsite beneath it
const results = await atlas.sharepoint.backup(site.siteId, { includeSubsites: true });
```

## Export and compliance

### Automated EML export

Export mailbox backups as archives on a schedule, for legal holds, compliance audits, or copies for departing employees.

```typescript
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

### Serving an export over HTTP

Give a user their own mailbox export without staging it on the application server. The archive streams to the response as it is built, so a read-only or ephemeral filesystem is not a problem, and disk use does not grow with mailbox size.

The mailbox must come from the authenticated session, never from the request. A route parameter would let any caller export any mailbox in the tenant, because Atlas authenticates as an application with tenant-wide access and cannot tell whose request it is serving.

```typescript
import express from 'express';

const app = express();

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

With `output` set, `outputPath` is empty in the result because nothing is written to disk. An export with no messages still ends the stream with a valid, empty archive. An interrupted run destroys the stream, so the client can tell it received an incomplete file. A failure before the export starts, such as a failed identity lookup, does not touch the response, so the handler must end it, as the example does. The drive workloads accept the same option: `atlas.onedrive.save(ownerId, { snapshotId, output: res })`.

## Maintenance and monitoring

### Periodic integrity verification

Confirm that data in S3 has not been corrupted or altered. This is the programmatic equivalent of `atlas outlook verify`.

```typescript
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

Verification downloads each encrypted object, decrypts it (which checks the AES-GCM authentication tag), recomputes the SHA-256 of the plaintext, and compares it with the manifest. A mismatch means the object was corrupted or altered. Objects that cannot be checked, such as attachments skipped by pre-fix backups, are listed as `unverifiable`, and an interrupted run never counts as a pass.

### Storage metrics

Pull storage statistics for a monitoring system such as Prometheus, Datadog, or Grafana, or for a dashboard of your own.

```typescript
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

For per-mailbox breakdowns:

```typescript
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

### Snapshot pruning

Do not prune snapshots one at a time with `deleteSnapshot`. Outlook and OneDrive manifests record only what changed in their run, and a restore folds in the older manifests of the same owner. Deleting an older manifest silently drops items that newer snapshots still need. Atlas has no chain-aware pruning. To remove an owner's data, use `atlas.outlook.deleteMailboxData` or `atlas.onedrive.deleteOwnerData`.

### OneDrive replication

Copy OneDrive snapshots to an offsite target. `replicateAll` resolves with one result per snapshot even when a copy ends `PARTIAL` or `FAILED`, so check each status.

```typescript
import type { AtlasInstance, StorageTarget } from '@wisecom/atlas-sdk';

async function replicate_onedrive(atlas: AtlasInstance, ownerId: string, offsite: StorageTarget) {
  const copies = await atlas.onedrive.replicateAll(ownerId, [offsite]);
  const incomplete = copies.filter((copy) => copy.status !== 'COMPLETED');

  if (incomplete.length > 0) {
    throw new Error(
      `${incomplete.length} of ${copies.length} snapshot(s) for ${ownerId} did not reach the offsite target`,
    );
  }

  console.log(`[replicated] ${ownerId}: ${copies.length} snapshot(s) synced to offsite`);
}
```
