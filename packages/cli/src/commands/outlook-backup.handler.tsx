import { Box } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { BackupUseCase, SyncOptions } from '@wisecom/atlas-types/ports/backup/use-case.port';
import type { TenantBackupOrchestrator } from '@wisecom/atlas-types';
import { BACKUP_USE_CASE_TOKEN, TENANT_ORCHESTRATOR_TOKEN } from '@wisecom/atlas-types';
import { run_backup_with_cli_adapter } from '@/adapters/backup-operation.adapter';
import { build_object_lock_policy, build_object_lock_request } from '@/command-object-lock';
import { run_tenant_backup_with_cli_adapter } from '@/adapters/tenant-backup-operation.adapter';
import { format_bytes } from '@/command-formatters';
import { report_run_outcome } from '@/command-run-outcome';
import { logger } from '@wisecom/atlas-core';
import { Banner } from '@/ui/components/banner';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

export interface OutlookBackupOptions {
  tenant?: string;
  mailbox?: string;
  folder?: string[];
  full?: boolean;
  pageSize?: string;
  retentionDays?: string;
  lockMode?: string;
  concurrency?: string;
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: OutlookBackupOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

/** Builds SyncOptions from CLI flags. */
function build_sync_options(options: OutlookBackupOptions): SyncOptions {
  const page_size = Math.max(1, Math.min(100, parseInt(options.pageSize ?? '10', 10) || 10));
  const object_lock_request = build_object_lock_request(options);
  const object_lock_policy = build_object_lock_policy(options);
  return {
    folder_filter: options.folder,
    force_full: options.full ?? false,
    page_size,
    object_lock_request,
    object_lock_policy,
  };
}

/** Dispatches a backup run for a single mailbox or the entire tenant. */
export async function execute_outlook_backup(
  container: Container,
  options: OutlookBackupOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const items: KeyValueItem[] = [{ label: 'Tenant', value: tenant_id }];
  if (options.folder) items.push({ label: 'Folders', value: options.folder.join(', ') });
  if (options.mailbox) items.push({ label: 'Mailbox', value: options.mailbox });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Backup" />
      <KeyValueList items={items} />
    </Box>,
  );

  if (options.mailbox) {
    await backup_single_mailbox(container, tenant_id, options.mailbox, build_sync_options(options));
  } else {
    await backup_all_mailboxes(container, tenant_id, options);
  }
}

/** Runs a single-mailbox backup and logs the outcome. */
async function backup_single_mailbox(
  container: Container,
  tenant_id: string,
  mailbox_id: string,
  sync_options: SyncOptions,
): Promise<void> {
  const backup_use_case = container.get<BackupUseCase>(BACKUP_USE_CASE_TOKEN);
  const result = await run_backup_with_cli_adapter(
    backup_use_case,
    tenant_id,
    mailbox_id,
    sync_options,
  );
  logger.success(
    `Snapshot ${result.snapshot.id} -- ` +
      `${result.manifest.total_objects} objects, ` +
      format_bytes(result.manifest.total_size_bytes),
  );
  report_run_outcome(
    {
      errors: result.summary.folder_errors,
      warnings: result.summary.warnings,
      interrupted: result.summary.interrupted,
    },
    'folder',
  );
}

/** Runs full-tenant backup via the orchestrator with CLI dashboard. */
async function backup_all_mailboxes(
  container: Container,
  tenant_id: string,
  options: OutlookBackupOptions,
): Promise<void> {
  const concurrency = Math.max(1, parseInt(options.concurrency ?? '4', 10) || 4);
  const page_size = Math.max(1, Math.min(100, parseInt(options.pageSize ?? '10', 10) || 10));
  const object_lock_request = build_object_lock_request(options);
  const object_lock_policy = build_object_lock_policy(options);

  logger.info(`Backing up all licensed and shared mailboxes (concurrency=${concurrency})`);

  const orchestrator = container.get<TenantBackupOrchestrator>(TENANT_ORCHESTRATOR_TOKEN);
  const result = await run_tenant_backup_with_cli_adapter(orchestrator, tenant_id, {
    concurrency,
    force_full: options.full ?? false,
    page_size,
    object_lock_request,
    object_lock_policy,
  });

  const mailbox_errors = result.outcomes
    .filter((o) => o.error !== undefined)
    .map((o) => `${o.owner_id}: ${o.error}`);
  report_run_outcome(
    {
      // Outcomes can be truncated on hard stops; the failed counter is authoritative.
      errors:
        result.failed > 0 && mailbox_errors.length === 0
          ? [`${result.failed} mailbox(es) failed`]
          : mailbox_errors,
      warnings: [],
      interrupted: result.interrupted,
    },
    'mailbox',
  );
}
