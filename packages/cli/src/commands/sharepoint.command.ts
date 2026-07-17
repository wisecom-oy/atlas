import type { Command } from 'commander';
import type { Container } from 'inversify';
import {
  execute_sharepoint_backup,
  execute_sharepoint_list_sites,
  execute_sharepoint_restore,
  execute_sharepoint_save,
  execute_sharepoint_verify,
  type SharePointBackupOptions,
  type SharePointRestoreCommandOptions,
  type SharePointSaveCommandOptions,
  type SharePointTenantOptions,
  type SharePointVerifyOptions,
} from '@/commands/sharepoint-command.handlers';
import {
  register_sharepoint_list_snapshots,
  register_sharepoint_list_versions,
} from '@/commands/sharepoint-catalog.command';

type ContainerFactory = () => Container;

/** Registers `atlas sharepoint` command group with backup and verify subcommands. */
export function register_sharepoint_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  const group = program
    .command('sharepoint')
    .description('SharePoint backup, restore, and verification commands');
  register_sharepoint_list_sites(group, get_container);
  register_sharepoint_list_snapshots(group, get_container);
  register_sharepoint_list_versions(group, get_container);
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
    .option(
      '--retention-days <n>',
      'apply Object Lock default retention for N days (persists on the bucket)',
    )
    .option('--lock-mode <mode>', 'Object Lock mode: governance|compliance')
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
