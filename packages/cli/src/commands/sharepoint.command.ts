import { Option } from 'commander';
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
import {
  execute_sharepoint_restore_version,
  type SharePointRestoreVersionOptions,
} from '@/commands/drive-version-restore.handlers';
import {
  execute_sharepoint_delete,
  execute_sharepoint_status,
  type SharePointDeleteOptions,
  type SharePointStatusCommandOptions,
} from '@/commands/sharepoint-data-ops.handlers';

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
  register_sharepoint_restore_version(group, get_container);
  register_sharepoint_backup(group, get_container);
  register_sharepoint_restore(group, get_container);
  register_sharepoint_save(group, get_container);
  register_sharepoint_verify(group, get_container);
  register_sharepoint_status(group, get_container);
  register_sharepoint_delete(group, get_container);
}

function register_sharepoint_restore_version(
  group: Command,
  get_container: ContainerFactory,
): void {
  group
    .command('restore-version')
    .description('Restore stored file versions back into a SharePoint library')
    .requiredOption('--site <url-or-id>', 'SharePoint site URL or site ID')
    .option('-f, --file <ref>', 'file ID or path; required with --version')
    .option('--version <id>', 'exact stored version to restore')
    .option('--before <iso>', "restore each file's last version at or before this instant")
    .option('--path <prefix>', 'limit a bulk rollback to this folder and below')
    .option('--in-place', 'upload over the original file instead of writing a copy beside it')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointRestoreVersionOptions) =>
      execute_sharepoint_restore_version(get_container(), options),
    );
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
    .option(
      '--include-subsites',
      'also back up every subsite beneath the site (one snapshot per subsite)',
    )
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
      '--destination <path>',
      'restore under this folder instead of a generated Restore-<timestamp> root',
    )
    .option('--in-place', 'restore to the original paths, mixing files into live content')
    .option('--name <filename>', 'rename the restored file; requires a single-file restore')
    .addOption(
      new Option('-c, --conflict <mode>', 'file conflict policy (default: rename)').choices([
        'replace',
        'rename',
        'fail',
      ]),
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

function register_sharepoint_status(group: Command, get_container: ContainerFactory): void {
  group
    .command('status')
    .description('Check whether a site SharePoint backup is up to date')
    .requiredOption('--site <site>', 'site URL, hostname, or composite site ID')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: SharePointStatusCommandOptions) =>
      execute_sharepoint_status(get_container(), options),
    );
}

function register_sharepoint_delete(group: Command, get_container: ContainerFactory): void {
  group
    .command('delete')
    .description('Delete SharePoint backups for one site, or a single snapshot')
    .requiredOption('--site <site>', 'site URL, hostname, or composite site ID')
    .option('-s, --snapshot <id>', 'delete a single snapshot instead of every backup')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-y, --yes', 'skip confirmation prompt')
    .action((options: SharePointDeleteOptions) =>
      execute_sharepoint_delete(get_container(), options),
    );
}
