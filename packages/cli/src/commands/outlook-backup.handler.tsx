import { Box } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { ExcludedFolder } from '@wisecom/atlas-types';
import type { BackupUseCase, SyncOptions } from '@wisecom/atlas-types/ports/backup/use-case.port';
import { BACKUP_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { run_backup_with_cli_adapter } from '@/adapters/backup-operation.adapter';
import { build_object_lock_policy, build_object_lock_request } from '@/command-object-lock';
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
  excludeJunk?: boolean;
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
    exclude_junk: options.excludeJunk ?? false,
  };
}

/** Runs a backup for the single mailbox given by the required -m flag. */
export async function execute_outlook_backup(
  container: Container,
  options: OutlookBackupOptions,
): Promise<void> {
  const { mailbox } = options;
  if (!mailbox) throw new Error('mailbox is required (pass -m, --mailbox <id>)');

  const tenant_id = resolve_tenant_id(container, options);
  const items: KeyValueItem[] = [{ label: 'Tenant', value: tenant_id }];
  if (options.folder) items.push({ label: 'Folders', value: options.folder.join(', ') });
  items.push({ label: 'Mailbox', value: mailbox });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Backup" />
      <KeyValueList items={items} />
    </Box>,
  );

  await backup_single_mailbox(container, tenant_id, mailbox, build_sync_options(options));
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
  report_excluded_folders(result.summary.excluded_folders);
  report_run_outcome(
    {
      errors: result.summary.folder_errors,
      warnings: result.summary.warnings,
      interrupted: result.summary.interrupted,
    },
    'folder',
  );
}

/**
 * Lists folders the run did not capture.
 *
 * A backup that omits a folder should say so on the run that omitted it, not
 * only in the manifest, or the operator learns about the gap from a failed
 * restore instead.
 */
function report_excluded_folders(excluded: readonly ExcludedFolder[]): void {
  if (excluded.length === 0) return;

  logger.warn(`${excluded.length} folder(s) not backed up:`);
  for (const folder of excluded.slice(0, EXCLUDED_FOLDER_REPORT_LIMIT)) {
    logger.warn(`  ${folder.folder_path} (${EXCLUSION_REASONS[folder.reason]})`);
  }
  const hidden = excluded.length - EXCLUDED_FOLDER_REPORT_LIMIT;
  if (hidden > 0) logger.warn(`  ...and ${hidden} more`);
}

/** Folders named individually before the summary collapses the rest. */
const EXCLUDED_FOLDER_REPORT_LIMIT = 10;

const EXCLUSION_REASONS: Record<ExcludedFolder['reason'], string> = {
  'junk-excluded': 'skipped by --exclude-junk',
  'hidden-system-folder': 'hidden Exchange system folder, holds no mail',
};
