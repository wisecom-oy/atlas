import type { Container } from 'inversify';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN, logger } from '@atlas/core';
import type {
  OneDriveBackupUseCase,
  OneDriveCatalogUseCase,
  OneDriveRestoreUseCase,
  OneDriveSaveUseCase,
  OneDriveVerificationUseCase,
  UserIdentityResolver,
} from '@atlas/types';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_RESTORE_USE_CASE_TOKEN,
  ONEDRIVE_SAVE_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@atlas/types';

export interface OneDriveTenantOptions {
  tenant?: string;
}

export interface OneDriveBackupOptions extends OneDriveTenantOptions {
  owner: string;
  full?: boolean;
}

export interface OneDriveListSnapshotsOptions extends OneDriveTenantOptions {
  owner: string;
}

export interface OneDriveListVersionsOptions extends OneDriveTenantOptions {
  owner: string;
  file: string;
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

function resolve_tenant_id(container: Container, options: OneDriveTenantOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

interface ResolvedOwner {
  readonly object_id: string;
  readonly email?: string;
  readonly display_name?: string;
}

/** Resolves owner: if it contains @, call UserIdentityResolver; otherwise use as-is. */
async function resolve_owner(
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
  const result = await backup.backup_onedrive(tenant_id, owner.object_id, {
    force_full: options.full ?? false,
    owner_email: owner.email,
    owner_display_name: owner.display_name,
  });

  logger.banner('Atlas OneDrive Backup');
  logger.info(`Owner: ${result.owner_id}`);
  logger.info(`Drives scanned: ${result.summary.drives_scanned}`);
  if (result.snapshot) {
    logger.success(`Snapshot ${result.snapshot.snapshot_id} created`);
    logger.info(
      `  Changed: ${result.summary.files_changed} | Stored: ${result.summary.files_stored} | Dedup: ${result.summary.files_deduplicated}`,
    );
    if (result.summary.deleted_items > 0) {
      logger.info(`  Deleted: ${result.summary.deleted_items}`);
    }
  } else {
    logger.info('No OneDrive changes detected. Snapshot skipped.');
  }

  const { versions_stored, versions_unavailable } = result.summary;
  if (versions_stored > 0 || versions_unavailable > 0) {
    logger.info(
      `  Versions: ${versions_stored} stored, ${versions_unavailable} unavailable (expired)`,
    );
  }

  if (result.summary.warnings.length > 0) {
    for (const w of result.summary.warnings) {
      logger.warn(`  ${w}`);
    }
  }

  if (result.summary.healthy) {
    logger.success('  Status: HEALTHY');
  } else {
    logger.error('  Status: UNHEALTHY');
    for (const err of result.summary.errors) {
      logger.error(`    - ${err}`);
    }
    process.exitCode = 1;
  }
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

  logger.banner('Atlas OneDrive Restore');
  logger.info(`Snapshot: ${result.snapshot_id}`);
  logger.info(`Files restored: ${result.files_restored}`);
  logger.info(`Folders created: ${result.folders_created}`);
  if (result.files_skipped > 0) {
    logger.warn(`Files skipped: ${result.files_skipped}`);
  }
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      logger.error(`  - ${err}`);
    }
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

  logger.banner('Atlas OneDrive Save');
  logger.info(`Snapshot: ${result.snapshot_id}`);
  logger.info(`Files saved: ${result.files_saved}`);
  if (result.files_skipped > 0) logger.warn(`Files skipped: ${result.files_skipped}`);
  if (result.integrity_failures.length > 0)
    logger.warn(`Integrity failures: ${result.integrity_failures.length}`);
  if (result.errors.length > 0) {
    for (const err of result.errors) logger.error(`  - ${err}`);
    process.exitCode = 1;
  } else {
    const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);
    logger.success(`Saved to ${result.output_path} (${size_mb} MB)`);
  }
}

export async function execute_onedrive_list_snapshots(
  container: Container,
  options: OneDriveListSnapshotsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const snapshots = await catalog.list_onedrive_snapshots(tenant_id, owner.object_id);

  logger.banner('Atlas OneDrive Snapshots');
  if (snapshots.length === 0) {
    logger.info('No OneDrive snapshots found.');
    return;
  }
  for (const snap of snapshots) {
    logger.info(`${snap.snapshot_id}  ${snap.created_at.toISOString()}  files=${snap.total_files}`);
  }
}

export async function execute_onedrive_list_versions(
  container: Container,
  options: OneDriveListVersionsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const owner = await resolve_owner(container, tenant_id, options.owner);
  const catalog = container.get<OneDriveCatalogUseCase>(ONEDRIVE_CATALOG_USE_CASE_TOKEN);
  const versions = await catalog.list_onedrive_file_versions(
    tenant_id,
    owner.object_id,
    options.file,
  );

  logger.banner('Atlas OneDrive File Versions');
  if (versions.length === 0) {
    logger.info('No versions found for this file.');
    return;
  }
  for (const ver of versions) {
    logger.info(
      `${ver.backup_at}  ${ver.snapshot_id}  ${ver.change_type}  ${ver.parent_path}/${ver.file_name}`,
    );
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

  logger.banner('Atlas OneDrive Verify');
  if (result.failed_file_ids.length === 0 && result.index_issues.length === 0) {
    logger.success(`All ${result.total_checked} entries passed verification`);
    return;
  }

  logger.error(
    `Failures: files=${result.failed_file_ids.length}, index=${result.index_issues.length}`,
  );
  for (const fid of result.failed_file_ids) logger.error(`  blob mismatch: ${fid}`);
  for (const issue of result.index_issues) logger.error(`  index: ${issue}`);
  process.exitCode = 1;
}
