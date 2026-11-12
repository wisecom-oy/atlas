import type { Container } from 'inversify';
import { Box } from 'ink';
import { report_unreadable_keys } from '@/command-unreadable-objects';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN, GRAPH_IDENTITY_RESOLVER_TOKEN, logger } from '@wisecom/atlas-core';
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
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { create_backup_progress } from '@/ui/dashboards/backup-progress-factory';
import { build_object_lock_request } from '@/command-object-lock';
import {
  EXIT_PARTIAL,
  report_run_outcome,
  report_skipped_items,
  report_unmatched_file_filters,
} from '@/command-run-outcome';
import {
  require_target_for_profile,
  resolve_restore_container,
  target_profile_items,
} from '@/commands/shared/restore-target-container';
import { run_interruptible } from '@/adapters/interruptible-run';
import {
  DRIVE_RESTORE_INTERRUPT_MESSAGE,
  report_drive_restore,
} from '@/commands/drive/restore-presenter';

export interface OneDriveTenantOptions {
  tenant?: string;
}

export interface OneDriveBackupOptions extends OneDriveTenantOptions {
  owner: string;
  full?: boolean;
  folder?: string;
  retentionDays?: string;
  lockMode?: string;
}

export interface OneDriveRestoreCommandOptions extends OneDriveTenantOptions {
  owner: string;
  snapshot: string;
  targetOwner?: string;
  targetProfile?: string;
  fileFilter?: string[];
  conflict?: 'replace' | 'rename' | 'fail';
  destination?: string;
  inPlace?: boolean;
  name?: string;
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
  const resolver = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);
  return resolve_owner_with(resolver, tenant_id, owner_input);
}

/**
 * Resolves a restore target through Graph alone, never the identity registry. The target lives in
 * the tenant the Graph credentials belong to, which in a cross-tenant restore is not the backed-up
 * tenant whose registry the caching resolver reads and writes.
 */
export async function resolve_restore_target(
  container: Container,
  tenant_id: string,
  target_input: string,
): Promise<ResolvedOwner> {
  const graph = container.get<UserIdentityResolver>(GRAPH_IDENTITY_RESOLVER_TOKEN);
  return resolve_owner_with(graph, tenant_id, target_input);
}

async function resolve_owner_with(
  resolver: UserIdentityResolver,
  tenant_id: string,
  owner_input: string,
): Promise<ResolvedOwner> {
  if (!owner_input.includes('@')) return { object_id: owner_input };
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
  // Built before the Graph lookup: invalid Object Lock flags must fail without a network call.
  const object_lock_request = build_object_lock_request(options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const backup = container.get<OneDriveBackupUseCase>(ONEDRIVE_BACKUP_USE_CASE_TOKEN);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('onedrive', 'Backup')} />
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

  const result = await run_interruptible(
    container,
    'Stopping the current transfer; the delta cursor is not advanced for an interrupted run',
    (gate) =>
      backup.backup_onedrive(tenant_id, owner.object_id, {
        force_full: options.full ?? false,
        ...(options.folder !== undefined ? { folder_scope: options.folder } : {}),
        owner_email: owner.email,
        owner_display_name: owner.display_name,
        object_lock_request,
        create_progress: create_backup_progress({
          rate: 'files/s',
          extra: 'ver',
          row_noun: 'drive',
        }),
        should_interrupt: gate.should_interrupt,
        abort_signal: gate.abort_signal,
      }),
  );
  if (result === undefined) return;

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
  } else if (result.summary.no_snapshot_reason === 'no_content') {
    // "No changes" on a drive that holds nothing reads as backed up, and there is no recovery
    // point at all (issue #405).
    logger.warn('No OneDrive content found. Nothing was backed up and no snapshot exists.');
  } else if (result.summary.no_snapshot_reason === 'no_changes') {
    logger.info('No OneDrive changes detected. Snapshot skipped.');
  } else {
    // No reason means the run was interrupted or unhealthy, so its changes did not land (#683).
    logger.warn('No snapshot created: the run was interrupted or every change failed.');
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
    // A ledger-only run has no error entry, so the verdict sets the exit code itself (#583).
    process.exitCode = EXIT_PARTIAL;
  }
  report_run_outcome(
    {
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      interrupted: result.interrupted,
    },
    'file',
  );
  report_unreadable_keys(result.summary.unreadable_keys);
}

export async function execute_onedrive_restore(
  container: Container,
  options: OneDriveRestoreCommandOptions,
): Promise<void> {
  require_target_for_profile(options.targetProfile, options.targetOwner, '--target-owner');
  const restore_container = resolve_restore_container(container, options.targetProfile);
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const target_owner = options.targetOwner
    ? await resolve_restore_target(restore_container, tenant_id, options.targetOwner)
    : undefined;
  const restore = restore_container.get<OneDriveRestoreUseCase>(ONEDRIVE_RESTORE_USE_CASE_TOKEN);
  const result = await run_interruptible(
    restore_container,
    DRIVE_RESTORE_INTERRUPT_MESSAGE,
    (gate) =>
      restore.restore_onedrive(tenant_id, owner.object_id, {
        snapshot_id: options.snapshot,
        ...(target_owner ? { target_owner_id: target_owner.object_id } : {}),
        ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
        ...(options.conflict ? { conflict_behavior: options.conflict } : {}),
        ...(options.destination ? { destination: options.destination } : {}),
        ...(options.inPlace === true ? { in_place: true } : {}),
        ...(options.name ? { rename_to: options.name } : {}),
        should_interrupt: gate.should_interrupt,
        abort_signal: gate.abort_signal,
      }),
  );
  if (result === undefined) return;

  await report_drive_restore(
    banner_title('onedrive', 'Restore'),
    result,
    target_profile_items(options.targetProfile, restore_container),
  );
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
      <Banner title={banner_title('onedrive', 'Save')} />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files saved', value: String(result.files_saved) },
        ]}
      />
    </Box>,
  );
  report_skipped_items(result.files_skipped, 'File');
  report_unreadable_keys(result.unreadable_keys);
  report_unmatched_file_filters(result.unmatched_file_filters);
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

  await render_static_view(<Banner title={banner_title('onedrive', 'Verify')} />);
  report_unreadable_keys(result.unreadable_keys);
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
