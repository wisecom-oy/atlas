# SDK Examples

Production-ready patterns for embedding Atlas in a Node.js application. Every example uses real SDK return types and handles the failure modes you will hit in production.

## Backup

### Conditional backup: check status first

The most common pattern. Check which mailboxes actually have pending changes before running expensive backup operations. This avoids unnecessary Graph API calls and reduces bandwidth during scheduled runs.

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
    console.log(`[skip] ${mailbox} — no changes since last backup`);
    continue;
  }

  console.log(
    `[backup] ${mailbox} — ${status.totalPendingChanges} pending change(s) across ${status.totalFolders} folder(s)`,
  );

  const result = await atlas.outlook.backup(mailbox);

  console.log(
    `[done] ${mailbox} — snapshot ${result.snapshot.id}, ` +
      `${result.summary.stored} stored, ${result.summary.deduplicated} deduped, ` +
      `${result.summary.attachmentsStored} attachments (${result.summary.elapsedMs}ms)`,
  );
}
```

`atlas.outlook.checkMailboxStatus` is a lightweight delta peek. It queries Graph without consuming the delta token, so the following `atlas.outlook.backup` call still picks up from the correct sync point.

### Nightly backup job with error handling

Backs up every mailbox, collects results, and exits with a code your process manager can act on (cron, systemd, an orchestration platform).

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
        console.log(`[skip] ${mailbox} — already current`);
        continue;
      }

      const result = await atlas.outlook.backup(mailbox);

      succeeded.push({
        mailbox,
        snapshotId: result.snapshot.id,
        stored: result.summary.stored,
        deduplicated: result.summary.deduplicated,
        attachments: result.summary.attachmentsStored,
        elapsedMs: result.summary.elapsedMs,
      });

      if (result.summary.interrupted) {
        console.warn(
          `[warn] ${mailbox} — backup was interrupted, ` +
            `${result.summary.completedFolderCount}/${result.summary.totalFolderCount} folders completed`,
        );
      }

      if (result.summary.folderErrors.length > 0) {
        console.warn(
          `[warn] ${mailbox} — ${result.summary.folderErrors.length} folder error(s): ` +
            result.summary.folderErrors.join(', '),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ mailbox, error: message });
      console.error(`[fail] ${mailbox} — ${message}`);
    }
  }

  console.log(`\nBackup complete: ${succeeded.length} succeeded, ${failed.length} failed`);

  return { succeeded, failed };
}

// --- entry point ---

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

The non-zero exit code on failure is what cron turns into an alert email, systemd records as `FailureAction`, and CI/CD pipelines treat as a failed step.

### Backup, replicate, and report

Back up each mailbox, immediately replicate the snapshot to an offsite target, and collect the results. This is the core loop for a 3-2-1 strategy. Adapt the reporting to whatever fits your stack: a webhook, a database row, a structured log, an email.

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
const results = [];
const replications: Promise<unknown>[] = [];

for (const mailbox of mailboxes) {
  try {
    const backup = await atlas.outlook.backup(mailbox);

    // Replication is S3-to-S3 only (no Graph API calls), so fire it off
    // concurrently while the next mailbox backup runs.
    replications.push(atlas.replicateSnapshot(backup.snapshot.id, [offsite]));

    results.push({
      mailbox,
      snapshotId: backup.snapshot.id,
      stored: backup.summary.stored,
      ok: true,
    });
  } catch (err) {
    results.push({ mailbox, ok: false, error: (err as Error).message });
  }
}

await Promise.allSettled(replications);

// results is a plain array -- send it wherever you want
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
```

Backups run sequentially to avoid Graph throttling, but each replication fires immediately without blocking the next backup. Replication is pure S3-to-S3 traffic, typically LAN or inter-datacenter fiber, so it runs safely in the background. `Promise.allSettled` ensures every replication finishes before the process exits.

A crash partway through costs nothing: the next run resumes on its own, because `atlas.outlook.backup` produces a delta snapshot and `replicateSnapshot` skips objects already on the target.

### OneDrive and SharePoint status check

Check for pending changes before running a OneDrive or SharePoint backup. This keeps scheduled jobs from burning cycles on unchanged data.

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

Managed service providers create one Atlas instance per tenant. Each instance is cryptographically isolated, with its own KEK, its own DEK, and its own S3 bucket.

```typescript
interface TenantConfig {
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailboxes: string[];
}

async function backup_all_tenants(
  tenants: TenantConfig[],
  shared_s3: { endpoint: string; accessKey: string; secretKey: string },
  passphrase: string,
) {
  for (const tenant of tenants) {
    console.log(`\n--- Tenant: ${tenant.name} (${tenant.tenantId}) ---`);

    const atlas = createAtlasInstance({
      tenantId: tenant.tenantId,
      clientId: tenant.clientId,
      clientSecret: tenant.clientSecret,
      s3Endpoint: shared_s3.endpoint,
      s3AccessKey: shared_s3.accessKey,
      s3SecretKey: shared_s3.secretKey,
      encryptionPassphrase: passphrase,
    });

    for (const mailbox of tenant.mailboxes) {
      try {
        const result = await atlas.outlook.backup(mailbox);
        console.log(`  [done] ${mailbox} — ${result.summary.stored} stored`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [fail] ${mailbox} — ${message}`);
      }
    }
  }
}
```

::: warning Sequential Processing Is Required
Process tenants and mailboxes **sequentially**, not with `Promise.all`. Each backup makes hundreds or thousands of Microsoft Graph API calls. Parallel execution would trigger aggressive HTTP 429 throttling with exponential backoff, making the total runtime longer, not shorter.
:::

## Discovery and pre-flight checks

### Pre-flight storage validation

Verify the bucket is correctly configured before the first immutable backup writes any data.

```typescript
async function validate_immutable_readiness(atlas: AtlasInstance) {
  const check = await atlas.checkStorage({
    mode: 'GOVERNANCE',
    retentionDays: 30,
  });

  console.log('Storage check results:');
  console.log(`  Bucket exists:    ${check.bucketExists}`);
  console.log(`  Versioning:       ${check.versioningEnabled}`);
  console.log(`  Object Lock:      ${check.objectLockEnabled}`);

  if (!check.bucketExists || !check.versioningEnabled || !check.objectLockEnabled) {
    throw new Error(
      'Storage is not ready for immutable backups. ' +
        'Ensure the bucket exists with versioning and Object Lock enabled.',
    );
  }

  console.log('Storage is ready for immutable backups.');
}
```

### Mailbox discovery and identity resolution

Discover tenant mailboxes and resolve user identities before running backups. This is the basis for onboarding workflows, audit dashboards, and automated provisioning.

```typescript
import { createAtlasInstance } from '@wisecom/atlas-sdk';

const atlas = createAtlasInstance({/* config */});

// Discover all tenant mailboxes (licensed users + shared mailboxes)
const mailboxes = await atlas.outlook.listAvailableMailboxes();

console.log(`Found ${mailboxes.length} mailboxes:`);
for (const mb of mailboxes) {
  if (mb.mailboxPurpose === 'shared') {
    console.log(`  ${mb.mail} — ${mb.displayName} (shared mailbox)`);
  } else {
    console.log(
      `  ${mb.mail} — ${mb.displayName} (${mb.hasExchangeLicense ? 'licensed' : 'unlicensed'})`,
    );
  }
}

// Resolve a user email to their Entra object ID
const user = await atlas.resolveUser('alice@company.com');
console.log(`Resolved: ${user.displayName} → ${user.objectId}`);

// List all users in the identity registry (previously backed-up users)
const registry = await atlas.listUsers();
if (registry) {
  for (const entry of registry.entries) {
    console.log(`  ${entry.email} — last seen: ${entry.lastBackupAt}`);
  }
}
```

`listAvailableMailboxes` queries Microsoft Graph directly, so it returns every tenant mailbox whether or not it has been backed up. Diff it against `atlas.outlook.listMailboxes()`, which returns only backed-up mailboxes from the catalog, to find mailboxes that are not yet protected.

### SharePoint site discovery

Discover SharePoint sites and resolve site URLs before running backups, for environments where the site inventory is not maintained by hand.

```typescript
// Discover all sites
const sites = await atlas.sharepoint.listSites();
for (const site of sites) {
  console.log(`${site.displayName}: ${site.webUrl}`);
}

// Resolve a site URL to its Graph site ID
const site = await atlas.sharepoint.resolveSite('https://contoso.sharepoint.com/sites/Engineering');
console.log(`Site ID: ${site.id}`);

// Back up the resolved site and every subsite beneath it
const results = await atlas.sharepoint.backup(site.id, { includeSubsites: true });
```

## Export and compliance

### Automated EML export

Export mailbox backups as `.eml` archives on a schedule, for legal holds, compliance audits, or portable copies for departing employees.

```typescript
async function export_mailbox_archive(atlas: AtlasInstance, mailbox: string, output_dir: string) {
  const timestamp = new Date().toISOString().slice(0, 10);
  const outputPath = `${output_dir}/${mailbox.replace('@', '_at_')}_${timestamp}.zip`;

  const result = await atlas.outlook.saveMailbox(mailbox, {
    outputPath,
    skipIntegrityCheck: false,
  });

  console.log(
    `[export] ${mailbox} — ${result.savedCount} messages, ` +
      `${result.attachmentCount} attachments, ` +
      `${(result.totalBytes / 1024 ** 2).toFixed(1)} MB → ${result.outputPath}`,
  );

  if (result.integrityFailures.length > 0) {
    console.warn(`[warn] ${result.integrityFailures.length} integrity failure(s) during export`);
  }

  return result;
}
```

## Maintenance and monitoring

### Periodic integrity verification

Confirm that data in S3 has not been corrupted or tampered with. This is the programmatic equivalent of `atlas outlook verify`.

```typescript
async function verify_recent_backups(atlas: AtlasInstance, mailboxes: string[]) {
  for (const mailbox of mailboxes) {
    const snapshots = await atlas.outlook.listSnapshots(mailbox);

    if (snapshots.length === 0) {
      console.log(`[skip] ${mailbox} — no snapshots`);
      continue;
    }

    const latest = snapshots[snapshots.length - 1];
    const result = await atlas.outlook.verify(latest.snapshotId);

    if (result.failed.length === 0) {
      console.log(`[pass] ${mailbox} — ${result.passed}/${result.totalChecked} objects verified`);
    } else {
      console.error(`[FAIL] ${mailbox} — ${result.failed.length} integrity failure(s):`);
      for (const failure of result.failed) {
        console.error(`  - ${failure}`);
      }
    }
  }
}
```

Verification downloads every encrypted object, decrypts it (validating the GCM authentication tag), recomputes the plaintext SHA-256, and compares it against the manifest. Any mismatch indicates corruption or tampering.

### Storage metrics

Pull storage statistics for a monitoring system such as Prometheus, Datadog, Grafana, or a dashboard of your own.

```typescript
async function collect_storage_metrics(atlas: AtlasInstance) {
  const stats = await atlas.getBucketStats();

  const metrics = {
    tenantId: stats.tenantId,
    totalMailboxes: stats.mailboxCount,
    total_snapshots: stats.snapshotCount,
    totalMessages: stats.totalMessages,
    total_size_gb: (stats.totalSizeBytes / 1024 ** 3).toFixed(2),
    total_attachments: stats.attachmentCount,
    attachment_size_gb: (stats.attachmentSizeBytes / 1024 ** 3).toFixed(2),
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
    mailbox: stats.mailbox_id,
    snapshots: stats.snapshotCount,
    messages: stats.totalMessages,
    size_mb: (stats.totalSizeBytes / 1024 ** 2).toFixed(1),
    attachments: stats.attachmentCount,
    folders: stats.folders.map((f) => ({
      id: f.folderId,
      messages: f.messageCount,
      size_mb: (f.totalSizeBytes / 1024 ** 2).toFixed(1),
    })),
  };
}
```

### Snapshot pruning

Keep the last N snapshots per mailbox and delete the rest, where storage cost matters more than deep history.

```typescript
async function prune_old_snapshots(atlas: AtlasInstance, mailbox: string, keep_count: number) {
  const snapshots = await atlas.outlook.listSnapshots(mailbox);

  if (snapshots.length <= keep_count) {
    console.log(`[skip] ${mailbox} — ${snapshots.length} snapshot(s), nothing to prune`);
    return;
  }

  const to_delete = snapshots.slice(0, snapshots.length - keep_count);

  for (const snapshot of to_delete) {
    const result = await atlas.outlook.deleteSnapshot(snapshot.snapshotId);
    console.log(
      `[prune] ${mailbox} — deleted snapshot ${snapshot.snapshotId} ` +
        `(${result.deletedObjects} objects removed)`,
    );
  }

  console.log(`[done] ${mailbox} — pruned ${to_delete.length} snapshot(s), kept ${keep_count}`);
}
```

::: tip Snapshot Deletion vs. Data Deletion
`atlas.outlook.deleteSnapshot` removes only the manifest file. The underlying data objects are retained because they may be referenced by other snapshots (content-addressed deduplication). To remove all data for a mailbox, use `atlas.outlook.deleteMailboxData`.
:::

### OneDrive snapshot pruning and replication

Prune old OneDrive snapshots, keep the recent ones, and replicate the keepers offsite.

```typescript
async function prune_and_replicate_onedrive(
  atlas: AtlasInstance,
  ownerId: string,
  keep_count: number,
  offsite: StorageTarget,
) {
  const snapshots = await atlas.onedrive.listSnapshots(ownerId);

  if (snapshots.length <= keep_count) {
    console.log(`[skip] ${ownerId} — ${snapshots.length} snapshot(s), nothing to prune`);
  } else {
    const to_delete = snapshots.slice(0, snapshots.length - keep_count);
    for (const snap of to_delete) {
      await atlas.onedrive.deleteSnapshot(ownerId, snap.snapshotId);
      console.log(`[prune] deleted ${snap.snapshotId}`);
    }
  }

  // Replicate remaining snapshots
  await atlas.onedrive.replicateAll(ownerId, [offsite]);
  console.log(`[replicated] ${ownerId} snapshots synced to offsite`);
}
```
