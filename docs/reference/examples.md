# SDK Examples

Production-ready patterns for integrating Atlas into your Node.js applications. These examples use real return types from the SDK and show how to handle the operational concerns you will encounter in production.

## Conditional Backup: Check Status First

The most common pattern. Check which mailboxes actually have pending changes before running expensive backup operations. This avoids unnecessary Graph API calls and reduces bandwidth during scheduled runs.

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({
  tenantId: process.env.ATLAS_TENANT_ID!,
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  s3Endpoint: process.env.ATLAS_S3_ENDPOINT!,
  s3AccessKey: process.env.ATLAS_S3_ACCESS_KEY!,
  s3SecretKey: process.env.ATLAS_S3_SECRET_KEY!,
  encryptionPassphrase: process.env.ATLAS_ENCRYPTION_PASSPHRASE!,
});

const mailboxes = [
  'ceo@company.com',
  'finance@company.com',
  'legal@company.com',
];

for (const mailbox of mailboxes) {
  const status = await atlas.outlook.checkMailboxStatus(mailbox);

  if (status.is_up_to_date) {
    console.log(`[skip] ${mailbox} — no changes since last backup`);
    continue;
  }

  console.log(
    `[backup] ${mailbox} — ${status.total_pending_changes} pending change(s) across ${status.total_folders} folder(s)`,
  );

  const result = await atlas.outlook.backup(mailbox);

  console.log(
    `[done] ${mailbox} — snapshot ${result.snapshot.id}, ` +
    `${result.summary.stored} stored, ${result.summary.deduplicated} deduped, ` +
    `${result.summary.attachments_stored} attachments (${result.summary.elapsed_ms}ms)`,
  );
}
```

`atlas.outlook.checkMailboxStatus` is a lightweight delta peek -- it queries Graph without consuming the delta token, so the subsequent `atlas.outlook.backup` call still picks up from the correct sync point.

## Nightly Backup Job with Error Handling

A robust scheduled job that backs up all mailboxes, collects results, and exits with an appropriate code for your process manager (cron, systemd, orchestration platform).

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';
import type { AtlasInstance } from 'm365-atlas/sdk';

interface BackupReport {
  mailbox: string;
  snapshot_id: string;
  stored: number;
  deduplicated: number;
  attachments: number;
  elapsed_ms: number;
}

async function run_nightly_backup(atlas: AtlasInstance, mailboxes: string[]) {
  const succeeded: BackupReport[] = [];
  const failed: { mailbox: string; error: string }[] = [];

  for (const mailbox of mailboxes) {
    try {
      const status = await atlas.outlook.checkMailboxStatus(mailbox);

      if (status.is_up_to_date) {
        console.log(`[skip] ${mailbox} — already current`);
        continue;
      }

      const result = await atlas.outlook.backup(mailbox);

      succeeded.push({
        mailbox,
        snapshot_id: result.snapshot.id,
        stored: result.summary.stored,
        deduplicated: result.summary.deduplicated,
        attachments: result.summary.attachments_stored,
        elapsed_ms: result.summary.elapsed_ms,
      });

      if (result.summary.interrupted) {
        console.warn(
          `[warn] ${mailbox} — backup was interrupted, ` +
          `${result.summary.completed_folder_count}/${result.summary.total_folder_count} folders completed`,
        );
      }

      if (result.summary.folder_errors.length > 0) {
        console.warn(
          `[warn] ${mailbox} — ${result.summary.folder_errors.length} folder error(s): ` +
          result.summary.folder_errors.join(', '),
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

const mailboxes = [
  'alice@company.com',
  'bob@company.com',
  'carol@company.com',
];

const { failed } = await run_nightly_backup(atlas, mailboxes);
process.exit(failed.length > 0 ? 1 : 0);
```

The non-zero exit code on failure integrates with cron (which can send alert emails on failure), systemd (which logs `FailureAction`), and CI/CD pipelines.

## Backup, Replicate, and Report

Back up each mailbox, immediately replicate the snapshot to an offsite target, and collect the results. This is the core loop for a 3-2-1 strategy -- adapt the reporting to whatever fits your stack (webhook, database row, structured log, email).

```typescript
import { createAtlasInstance, createStorageTarget } from 'm365-atlas/sdk';

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

    results.push({ mailbox, snapshot_id: backup.snapshot.id, stored: backup.summary.stored, ok: true });
  } catch (err) {
    results.push({ mailbox, ok: false, error: (err as Error).message });
  }
}

await Promise.allSettled(replications);

// results is a plain array -- send it wherever you want
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
```

Backups run sequentially to avoid Graph API throttling, but each replication fires off immediately without blocking the next backup. Replication is pure S3-to-S3 traffic (typically LAN or inter-datacenter fiber), so it runs concurrently in the background. `Promise.allSettled` at the end ensures all replications finish before the process exits. If the job crashes partway, the next run picks up naturally -- `atlas.outlook.backup` produces a delta snapshot and `replicateSnapshot` skips objects already on the target.

## Periodic Integrity Verification

Run `atlas.outlook.verify` on recent snapshots to confirm that data in S3 has not been corrupted or tampered with. This is the programmatic equivalent of `atlas outlook verify`.

```typescript
async function verify_recent_backups(atlas: AtlasInstance, mailboxes: string[]) {
  for (const mailbox of mailboxes) {
    const snapshots = await atlas.outlook.listSnapshots(mailbox);

    if (snapshots.length === 0) {
      console.log(`[skip] ${mailbox} — no snapshots`);
      continue;
    }

    const latest = snapshots[snapshots.length - 1];
    const result = await atlas.outlook.verify(latest.snapshot_id);

    if (result.failed.length === 0) {
      console.log(
        `[pass] ${mailbox} — ${result.passed}/${result.total_checked} objects verified`,
      );
    } else {
      console.error(
        `[FAIL] ${mailbox} — ${result.failed.length} integrity failure(s):`,
      );
      for (const failure of result.failed) {
        console.error(`  - ${failure}`);
      }
    }
  }
}
```

Verification downloads every encrypted object, decrypts it (validating the GCM authentication tag), recomputes the plaintext SHA-256, and compares it against the manifest. Any mismatch indicates corruption or tampering.

## Storage Monitoring Dashboard

Pull storage statistics to feed into a monitoring system (Prometheus, Datadog, Grafana, or a custom dashboard).

```typescript
async function collect_storage_metrics(atlas: AtlasInstance) {
  const stats = await atlas.getBucketStats();

  const metrics = {
    tenant_id: stats.tenant_id,
    total_mailboxes: stats.mailbox_count,
    total_snapshots: stats.snapshot_count,
    total_messages: stats.total_messages,
    total_size_gb: (stats.total_size_bytes / (1024 ** 3)).toFixed(2),
    total_attachments: stats.attachment_count,
    attachment_size_gb: (stats.attachment_size_bytes / (1024 ** 3)).toFixed(2),
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
    snapshots: stats.snapshot_count,
    messages: stats.total_messages,
    size_mb: (stats.total_size_bytes / (1024 ** 2)).toFixed(1),
    attachments: stats.attachment_count,
    folders: stats.folders.map((f) => ({
      id: f.folder_id,
      messages: f.message_count,
      size_mb: (f.total_size_bytes / (1024 ** 2)).toFixed(1),
    })),
  };
}
```

## Automated EML Export for Compliance

Export mailbox backups as `.eml` archives on a schedule -- useful for legal holds, compliance audits, or providing portable copies to departing employees.

```typescript
async function export_mailbox_archive(
  atlas: AtlasInstance,
  mailbox: string,
  output_dir: string,
) {
  const timestamp = new Date().toISOString().slice(0, 10);
  const output_path = `${output_dir}/${mailbox.replace('@', '_at_')}_${timestamp}.zip`;

  const result = await atlas.outlook.saveMailbox(mailbox, {
    output_path,
    skip_integrity_check: false,
  });

  console.log(
    `[export] ${mailbox} — ${result.saved_count} messages, ` +
    `${result.attachment_count} attachments, ` +
    `${(result.total_bytes / (1024 ** 2)).toFixed(1)} MB → ${result.output_path}`,
  );

  if (result.integrity_failures.length > 0) {
    console.warn(
      `[warn] ${result.integrity_failures.length} integrity failure(s) during export`,
    );
  }

  return result;
}
```

## Pre-Flight Storage Validation

Before running your first immutable backup, verify that the S3 bucket is correctly configured. This catches misconfiguration before any data is written.

```typescript
async function validate_immutable_readiness(atlas: AtlasInstance) {
  const check = await atlas.checkStorage({
    mode: 'GOVERNANCE',
    retention_days: 30,
  });

  console.log('Storage check results:');
  console.log(`  Bucket exists:    ${check.bucket_exists}`);
  console.log(`  Versioning:       ${check.versioning_enabled}`);
  console.log(`  Object Lock:      ${check.object_lock_enabled}`);

  if (!check.bucket_exists || !check.versioning_enabled || !check.object_lock_enabled) {
    throw new Error(
      'Storage is not ready for immutable backups. ' +
      'Ensure the bucket exists with versioning and Object Lock enabled.',
    );
  }

  console.log('Storage is ready for immutable backups.');
}
```

## Multi-Tenant Management

For managed service providers backing up multiple tenants, create separate Atlas instances per tenant. Each instance is cryptographically isolated -- different KEK, different DEK, different S3 bucket.

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

## Mailbox Discovery and Identity Resolution

Discover available mailboxes in the tenant and resolve user identities before running backups. Useful for building onboarding workflows, audit dashboards, or automated user provisioning.

```typescript
import { createAtlasInstance } from 'm365-atlas/sdk';

const atlas = createAtlasInstance({ /* config */ });

// Discover all licensed mailboxes in the tenant
const mailboxes = await atlas.outlook.listAvailableMailboxes({ licensed_only: true });

console.log(`Found ${mailboxes.length} licensed mailboxes:`);
for (const mb of mailboxes) {
  console.log(`  ${mb.mail} — ${mb.display_name} (${mb.account_enabled ? 'active' : 'disabled'})`);
}

// Resolve a user email to their Entra object ID
const user = await atlas.resolveUser('alice@company.com');
console.log(`Resolved: ${user.display_name} → ${user.object_id}`);

// List all users in the identity registry (previously backed-up users)
const registry = await atlas.listUsers();
if (registry) {
  for (const entry of registry.entries) {
    console.log(`  ${entry.email} — last seen: ${entry.last_backup_at}`);
  }
}
```

`listAvailableMailboxes` queries Microsoft Graph directly -- it returns all tenant mailboxes regardless of whether they have been backed up. Use it alongside `atlas.outlook.listMailboxes()` (which returns only backed-up mailboxes from the catalog) to find mailboxes that are not yet protected.

## OneDrive and SharePoint Status Check

Before running OneDrive or SharePoint backups, check whether there are pending changes. This avoids unnecessary backup cycles in scheduled jobs.

```typescript
// OneDrive status check
const odStatus = await atlas.onedrive.checkStatus('owner-id');

if (odStatus.is_up_to_date) {
  console.log('[skip] OneDrive is current');
} else {
  console.log(`[backup] ${odStatus.total_pending_changes} pending changes across ${odStatus.total_drives} drive(s)`);
  await atlas.onedrive.backup('owner-id');
}

// SharePoint status check
const spStatus = await atlas.sharepoint.checkStatus('site-id');

if (spStatus.is_up_to_date) {
  console.log('[skip] SharePoint site is current');
} else {
  console.log(`[backup] ${spStatus.total_pending_changes} pending changes across ${spStatus.total_libraries} library/libraries`);
  await atlas.sharepoint.backup('site-id');
}
```

## SharePoint Site Discovery

Discover available SharePoint sites and resolve site URLs before running backups. Useful for managed environments where site inventory is not maintained manually.

```typescript
// Discover all sites
const sites = await atlas.sharepoint.listSites();
for (const site of sites) {
  console.log(`${site.displayName}: ${site.webUrl}`);
}

// Resolve a site URL to its Graph site ID
const site = await atlas.sharepoint.resolveSite('https://contoso.sharepoint.com/sites/Engineering');
console.log(`Site ID: ${site.id}`);

// Back up the resolved site
const result = await atlas.sharepoint.backup(site.id);
```

## OneDrive Lifecycle Management

Clean up old OneDrive snapshots while keeping recent ones, and replicate the keepers to an offsite target.

```typescript
async function prune_and_replicate_onedrive(
  atlas: AtlasInstance,
  owner_id: string,
  keep_count: number,
  offsite: StorageTarget,
) {
  const snapshots = await atlas.onedrive.listSnapshots(owner_id);

  if (snapshots.length <= keep_count) {
    console.log(`[skip] ${owner_id} — ${snapshots.length} snapshot(s), nothing to prune`);
  } else {
    const to_delete = snapshots.slice(0, snapshots.length - keep_count);
    for (const snap of to_delete) {
      await atlas.onedrive.deleteSnapshot(owner_id, snap.snapshot_id);
      console.log(`[prune] deleted ${snap.snapshot_id}`);
    }
  }

  // Replicate remaining snapshots
  await atlas.onedrive.replicateAll(owner_id, [offsite]);
  console.log(`[replicated] ${owner_id} snapshots synced to offsite`);
}
```

## Snapshot Lifecycle Management

Clean up old snapshots while keeping recent ones. Useful for environments where storage costs matter and you only need the last N snapshots per mailbox.

```typescript
async function prune_old_snapshots(
  atlas: AtlasInstance,
  mailbox: string,
  keep_count: number,
) {
  const snapshots = await atlas.outlook.listSnapshots(mailbox);

  if (snapshots.length <= keep_count) {
    console.log(`[skip] ${mailbox} — ${snapshots.length} snapshot(s), nothing to prune`);
    return;
  }

  const to_delete = snapshots.slice(0, snapshots.length - keep_count);

  for (const snapshot of to_delete) {
    const result = await atlas.outlook.deleteSnapshot(snapshot.snapshot_id);
    console.log(
      `[prune] ${mailbox} — deleted snapshot ${snapshot.snapshot_id} ` +
      `(${result.deleted_count} objects removed)`,
    );
  }

  console.log(
    `[done] ${mailbox} — pruned ${to_delete.length} snapshot(s), kept ${keep_count}`,
  );
}
```

::: tip Snapshot Deletion vs. Data Deletion
`atlas.outlook.deleteSnapshot` removes only the manifest file. The underlying data objects are retained because they may be referenced by other snapshots (content-addressed deduplication). To remove all data for a mailbox, use `atlas.outlook.deleteMailboxData`.
:::
