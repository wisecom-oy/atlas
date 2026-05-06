import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN, logger } from '@atlas/core';
import type {
  OneDriveBackupUseCase,
  OneDriveCatalogUseCase,
  OneDriveVerificationUseCase,
  UserIdentityResolver,
} from '@atlas/types';
import {
  ONEDRIVE_BACKUP_USE_CASE_TOKEN,
  ONEDRIVE_CATALOG_USE_CASE_TOKEN,
  ONEDRIVE_VERIFICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@atlas/types';

type ContainerFactory = () => Container;

interface OneDriveTenantOptions {
  tenant?: string;
}

interface OneDriveBackupOptions extends OneDriveTenantOptions {
  owner: string;
  full?: boolean;
}

interface OneDriveListSnapshotsOptions extends OneDriveTenantOptions {
  owner: string;
}

interface OneDriveListVersionsOptions extends OneDriveTenantOptions {
  owner: string;
  file: string;
}

interface OneDriveVerifyOptions extends OneDriveTenantOptions {
  snapshot: string;
}

/** Registers `atlas onedrive` command group with backup, list, and verify subcommands. */
export function register_onedrive_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('onedrive')
    .description('OneDrive backup and verification commands');
  register_onedrive_backup(group, get_container);
  register_onedrive_list_snapshots(group, get_container);
  register_onedrive_list_versions(group, get_container);
  register_onedrive_verify(group, get_container);
}

function register_onedrive_backup(group: Command, get_container: ContainerFactory): void {
  group
    .command('backup')
    .description('Back up changed OneDrive files for one user')
    .requiredOption('-o, --owner <id>', 'user email or Entra object ID')
    .option('--full', 'force full crawl ignoring saved delta state')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveBackupOptions) => execute_onedrive_backup(get_container(), options));
}

function register_onedrive_list_snapshots(group: Command, get_container: ContainerFactory): void {
  group
    .command('list-snapshots')
    .description('List OneDrive snapshots for a user')
    .requiredOption('-o, --owner <id>', 'user email or Entra object ID')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveListSnapshotsOptions) =>
      execute_onedrive_list_snapshots(get_container(), options),
    );
}

function register_onedrive_list_versions(group: Command, get_container: ContainerFactory): void {
  group
    .command('list-versions')
    .description('List all backed-up versions for a specific file')
    .requiredOption('-o, --owner <id>', 'user email or Entra object ID')
    .requiredOption('-f, --file <ref>', 'file ID or path')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveListVersionsOptions) =>
      execute_onedrive_list_versions(get_container(), options),
    );
}

function register_onedrive_verify(group: Command, get_container: ContainerFactory): void {
  group
    .command('verify')
    .description('Verify integrity of a OneDrive snapshot')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveVerifyOptions) => execute_onedrive_verify(get_container(), options));
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

async function execute_onedrive_backup(
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

async function execute_onedrive_list_snapshots(
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

async function execute_onedrive_list_versions(
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

async function execute_onedrive_verify(
  container: Container,
  options: OneDriveVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const verifier = container.get<OneDriveVerificationUseCase>(ONEDRIVE_VERIFICATION_USE_CASE_TOKEN);
  const result = await verifier.verify_onedrive_snapshot(tenant_id, options.snapshot);

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
