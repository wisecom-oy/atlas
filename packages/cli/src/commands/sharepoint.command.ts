import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN, logger } from '@atlas/core';
import type {
  SharePointBackupUseCase,
  SharePointRestoreUseCase,
  SharePointSaveUseCase,
  SharePointSiteConnector,
  SharePointVerificationUseCase,
} from '@atlas/types';
import {
  SHAREPOINT_BACKUP_USE_CASE_TOKEN,
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_RESTORE_USE_CASE_TOKEN,
  SHAREPOINT_SAVE_USE_CASE_TOKEN,
  SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
} from '@atlas/types';

type ContainerFactory = () => Container;

interface SharePointTenantOptions {
  tenant?: string;
}

interface SharePointBackupOptions extends SharePointTenantOptions {
  site: string;
  full?: boolean;
}

interface SharePointVerifyOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
}

interface SharePointRestoreCommandOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
  targetSite?: string;
  fileFilter?: string[];
  conflict?: 'replace' | 'rename' | 'fail';
}

interface SharePointSaveCommandOptions extends SharePointTenantOptions {
  site: string;
  snapshot: string;
  fileFilter?: string[];
  output?: string;
  skipVerify?: boolean;
}

/** Registers `atlas sharepoint` command group with backup and verify subcommands. */
export function register_sharepoint_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  const group = program
    .command('sharepoint')
    .description('SharePoint backup, restore, and verification commands');
  register_sharepoint_list_sites(group, get_container);
  register_sharepoint_backup(group, get_container);
  register_sharepoint_restore(group, get_container);
  register_sharepoint_save(group, get_container);
  register_sharepoint_verify(group, get_container);
}

function register_sharepoint_list_sites(group: Command, get_container: ContainerFactory): void {
  group
    .command('list-sites')
    .description('List all SharePoint sites in the tenant')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointTenantOptions) =>
      execute_sharepoint_list_sites(get_container(), options),
    );
}

function register_sharepoint_backup(group: Command, get_container: ContainerFactory): void {
  group
    .command('backup')
    .description('Back up changed files in a SharePoint site')
    .requiredOption('--site <url-or-id>', 'SharePoint site URL or site ID')
    .option('--full', 'force full crawl ignoring saved delta state')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointBackupOptions) =>
      execute_sharepoint_backup(get_container(), options),
    );
}

function register_sharepoint_restore(group: Command, get_container: ContainerFactory): void {
  group
    .command('restore')
    .description('Restore files from a SharePoint snapshot')
    .requiredOption('--site <url-or-id>', 'SharePoint site URL or site ID')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('--target-site <url-or-id>', 'target site to restore to (defaults to original site)')
    .option('--file-filter <paths...>', 'only restore specific files (by ID or path)')
    .option(
      '-c, --conflict <mode>',
      'file conflict policy: replace, rename, or fail (default: rename)',
    )
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointRestoreCommandOptions) =>
      execute_sharepoint_restore(get_container(), options),
    );
}

function register_sharepoint_save(group: Command, get_container: ContainerFactory): void {
  group
    .command('save')
    .description('Save files from a SharePoint snapshot to a local zip archive')
    .requiredOption('--site <url-or-id>', 'SharePoint site URL or site ID')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('--file-filter <paths...>', 'only save specific files (by ID or path)')
    .option('-O, --output <path>', 'output zip file path')
    .option('--skip-verify', 'skip SHA-256 integrity checks')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointSaveCommandOptions) =>
      execute_sharepoint_save(get_container(), options),
    );
}

function register_sharepoint_verify(group: Command, get_container: ContainerFactory): void {
  group
    .command('verify')
    .description('Verify integrity of a SharePoint snapshot')
    .requiredOption('--site <url-or-id>', 'SharePoint site URL or site ID')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointVerifyOptions) =>
      execute_sharepoint_verify(get_container(), options),
    );
}

function resolve_tenant_id(container: Container, options: SharePointTenantOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

async function execute_sharepoint_list_sites(
  container: Container,
  options: SharePointTenantOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const sites = await connector.list_sites(tenant_id);

  logger.banner('Atlas SharePoint Sites');
  if (sites.length === 0) {
    logger.info('No SharePoint sites found.');
    return;
  }

  for (const site of sites) {
    logger.info(`${site.site_id}  ${site.display_name}  ${site.site_url}`);
  }

  logger.info(`\n${sites.length} site(s) found.`);
}

async function execute_sharepoint_backup(
  container: Container,
  options: SharePointBackupOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  const backup = container.get<SharePointBackupUseCase>(SHAREPOINT_BACKUP_USE_CASE_TOKEN);
  const result = await backup.backup_site(tenant_id, site.site_id, {
    force_full: options.full ?? false,
    site_url: site.site_url,
    site_display_name: site.display_name,
  });

  logger.banner('Atlas SharePoint Backup');
  logger.info(`Site: ${result.site_id}`);
  logger.info(`Libraries scanned: ${result.summary.libraries_scanned}`);
  if (result.snapshot) {
    logger.success(`Snapshot ${result.snapshot.snapshot_id} created`);
    logger.info(
      `  Changed: ${result.summary.files_changed} | Stored: ${result.summary.files_stored} | Dedup: ${result.summary.files_deduplicated}`,
    );
    if (result.summary.deleted_items > 0) {
      logger.info(`  Deleted: ${result.summary.deleted_items}`);
    }
  } else {
    logger.info('No SharePoint changes detected. Snapshot skipped.');
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

async function execute_sharepoint_restore(
  container: Container,
  options: SharePointRestoreCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  let target_site_id: string | undefined;
  if (options.targetSite) {
    const target = await connector.resolve_site(tenant_id, options.targetSite);
    logger.info(`Target site: ${target.display_name} (${target.site_id})`);
    target_site_id = target.site_id;
  }

  const restore = container.get<SharePointRestoreUseCase>(SHAREPOINT_RESTORE_USE_CASE_TOKEN);
  const result = await restore.restore_sharepoint(tenant_id, site.site_id, {
    snapshot_id: options.snapshot,
    ...(target_site_id ? { target_site_id } : {}),
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.conflict ? { conflict_behavior: options.conflict } : {}),
  });

  logger.banner('Atlas SharePoint Restore');
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

async function execute_sharepoint_save(
  container: Container,
  options: SharePointSaveCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  const save_uc = container.get<SharePointSaveUseCase>(SHAREPOINT_SAVE_USE_CASE_TOKEN);
  const result = await save_uc.save_snapshot(tenant_id, site.site_id, {
    snapshot_id: options.snapshot,
    ...(options.fileFilter ? { file_filter: options.fileFilter } : {}),
    ...(options.output ? { output_path: options.output } : {}),
    ...(options.skipVerify ? { skip_integrity_check: true } : {}),
  });

  logger.banner('Atlas SharePoint Save');
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

async function execute_sharepoint_verify(
  container: Container,
  options: SharePointVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const connector = container.get<SharePointSiteConnector>(SHAREPOINT_CONNECTOR_TOKEN);
  const site = await connector.resolve_site(tenant_id, options.site);
  logger.info(`Resolved site: ${site.display_name} (${site.site_id})`);

  const verifier = container.get<SharePointVerificationUseCase>(
    SHAREPOINT_VERIFICATION_USE_CASE_TOKEN,
  );
  const result = await verifier.verify_sharepoint_snapshot(
    tenant_id,
    site.site_id,
    options.snapshot,
  );

  logger.banner('Atlas SharePoint Verify');
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
