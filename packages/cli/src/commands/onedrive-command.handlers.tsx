import type { Container } from 'inversify';
import { Box } from 'ink';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type {
  OneDriveBackupUseCase,
  OneDriveRestoreUseCase,
  OneDriveSaveUseCase,
  OneDriveVerificationUseCase,
  UserIdentityResolver,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { create_backup_progress } from '@/ui/dashboards/backup-progress-factory';
import { build_object_lock_request } from '@/command-object-lock';
import { report_run_outcome } from '@/command-run-outcome';

export interface OneDriveTenantOptions {
  tenant?: string;
}

export interface OneDriveBackupOptions extends OneDriveTenantOptions {
  owner: string;
  full?: boolean;
  retentionDays?: string;
  lockMode?: string;
}

export interface OneDriveRestoreCommandOptions extends OneDriveTenantOptions {
  owner: string;
  snapshot: string;
  targetOwner?: string;
  fileFilter?: string[];
  conflict?: 'replace' | 'rename' | 'fail';
}

export interface OneDriveVerifyOptions extends OneDriveTenantOptions {
  owner: string;
  snapshot: string;
}

export interface OneDriveSaveCommandOptions extends OneDriveTenantOptions {
  owner: string;
  snapshot: string;
  fileFilter?: string[];
  output?: string;
  skipVerify?: boolean;
}

/** Resolves the tenant id from CLI options, falling back to the configured tenant. */
export function resolve_tenant_id(container: Container, options: OneDriveTenantOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

export interface ResolvedOwner {
  readonly object_id: string;
  readonly email?: string;
  readonly display_name?: string;
}

/** Resolves owner: if it contains @, call UserIdentityResolver; otherwise use as-is. */
export async function resolve_owner(
  container: Container,
  tenant_id: string,
  owner_input: string,
): Promise<ResolvedOwner> {
  if (!owner_input.includes('@')) return { object_id: owner_input };
  const resolver = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);
  const identity = await resolver.resolve_user(tenant_id, owner_input);
  logger.info(`Resolved ${owner_input} -> ${identity.object_id} (${identity.display_name})`);
  return {
    object_id: identity.object_id,
    email: identity.email,
    display_name: identity.display_name,
  };
}

export async function execute_onedrive_backup(
  container: Container,
  options: OneDriveBackupOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const backup = container.get<OneDriveBackupUseCase>(ONEDRIVE_BACKUP_USE_CASE_TOKEN);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas OneDrive Backup" />
      <KeyValueList
        items={[
          {
            label: 'Owner',
            value: owner.display_name
              ? `${owner.display_name} (${owner.object_id})`
              : owner.object_id,
          },
        ]}
      />
    </Box>,
  );

  const result = await backup.backup_onedrive(tenant_id, owner.object_id, {
    force_full: options.full ?? false,
    owner_email: owner.email,
    owner_display_name: owner.display_name,
    object_lock_request: build_object_lock_request(options),
    create_progress: create_backup_progress({ rate: 'files/s', extra: 'ver', row_noun: 'drive' }),
  });

  if (result.snapshot) {
    logger.success(`Snapshot ${result.snapshot.snapshot_id} created`);
    const counters: SummaryEntry[] = [
      { label: 'changed', value: result.summary.files_changed, color: 'cyan' },
      { label: 'stored', value: result.summary.files_stored, color: 'green' },
      { label: 'dedup', value: result.summary.files_deduplicated, color: 'yellow' },
    ];
    if (result.summary.deleted_items > 0) {
      counters.push({ label: 'deleted', value: result.summary.deleted_items, color: 'red' });
    }
    await render_static_view(<ResultSummary entries={counters} />);
  } else {
    logger.info('No OneDrive changes detected. Snapshot skipped.');
  }

  const { versions_stored, versions_unavailable } = result.summary;
  if (versions_stored > 0 || versions_unavailable > 0) {
    logger.info(
      `Versions: ${versions_stored} stored, ${versions_unavailable} unavailable (expired)`,
    );
  }

  if (result.summary.healthy) {
    logger.success('Status: HEALTHY');
  } else {
    logger.error('Status: UNHEALTHY');
  }
  report_run_outcome({ errors: result.summary.errors, warnings: result.summary.warnings }, 'file');
}

export async function execute_onedrive_restore(
  container: Container,
  options: OneDriveRestoreCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const target_owner = options.targetOwner
    ? await resolve_owner(container, tenant_id, options.targetOwner)
    : undefined;
  const restore = container.get<OneDriveRestoreUseCase>(ONEDRIVE_RESTORE_USE_CASE_TOKEN);
  const result = await restore.restore_onedrive(tenant_id, owner.object_id, {
    snapshot_id: options.snapshot,
    ...(target_owner ? { target_owner_id: target_owner.object_id } : {}),
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.conflict ? { conflict_behavior: options.conflict } : {}),
  });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas OneDrive Restore" />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files restored', value: String(result.files_restored) },
          { label: 'Folders created', value: String(result.folders_created) },
        ]}
      />
    </Box>,
  );
  if (result.files_skipped > 0) {
    logger.warn(`Files skipped: ${result.files_skipped}`);
  }
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
    process.exitCode = 1;
  } else {
    logger.success('Restore completed successfully');
  }
}

export async function execute_onedrive_save(
  container: Container,
  options: OneDriveSaveCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const save_uc = container.get<OneDriveSaveUseCase>(ONEDRIVE_SAVE_USE_CASE_TOKEN);
  const result = await save_uc.save_snapshot(tenant_id, owner.object_id, {
    snapshot_id: options.snapshot,
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.output ? { output_path: options.output } : {}),
    ...(options.skipVerify ? { skip_integrity_check: true } : {}),
  });

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas OneDrive Save" />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files saved', value: String(result.files_saved) },
        ]}
      />
    </Box>,
  );
  if (result.files_skipped > 0) logger.warn(`Files skipped: ${result.files_skipped}`);
  if (result.integrity_failures.length > 0)
    logger.warn(`Integrity failures: ${result.integrity_failures.length}`);
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
    process.exitCode = 1;
  } else {
    const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);
    logger.success(`Saved to ${result.output_path} (${size_mb} MB)`);
  }
}

export async function execute_onedrive_verify(
  container: Container,
  options: OneDriveVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const verifier = container.get<OneDriveVerificationUseCase>(ONEDRIVE_VERIFICATION_USE_CASE_TOKEN);
  const result = await verifier.verify_onedrive_snapshot(
    tenant_id,
    owner.object_id,
    options.snapshot,
  );

  await render_static_view(<Banner title="Atlas OneDrive Verify" />);
  if (result.failed_file_ids.length === 0 && result.index_issues.length === 0) {
    logger.success(`All ${result.total_checked} entries passed verification`);
    return;
  }

  logger.error(
    `Failures: files=${result.failed_file_ids.length}, index=${result.index_issues.length}`,
  );
  const failures = [
    ...result.failed_file_ids.map((fid) => `blob mismatch: ${fid}`),
    ...result.index_issues.map((issue) => `index: ${issue}`),
  ];
  await render_static_view(<ErrorList errors={failures} max={failures.length} />);
  process.exitCode = 1;
}
