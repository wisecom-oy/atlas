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
import {
  with_conflict,
  with_file_filter,
  with_object_lock,
  with_output,
  with_required_snapshot,
  with_snapshot,
  with_tenant,
  with_yes,
} from '@/commands/shared-options';

type ContainerFactory = () => Container;

// `--site` carries no short flag: `-s` is the snapshot on every command that has one, and a site
// and a snapshot are the two values an operator is most likely to confuse (issue #162).
const SITE_FLAG = '--site <url-or-id>';
const SITE_DESCRIPTION = 'SharePoint site URL, hostname, or composite site ID';

/** Registers `atlas sharepoint` command group. */
export function register_sharepoint_command(
  program: Command,
  get_container: ContainerFactory,
): void {
  const group = program
    .command('sharepoint')
    .description(
      'SharePoint backup, restore, save, verify, catalog, status, and deletion commands',
    );
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
  const command = group
    .command('restore-version')
    .description('Restore stored file versions back into a SharePoint library')
    .requiredOption(SITE_FLAG, SITE_DESCRIPTION)
    .option('-f, --file <ref>', 'file ID or path; required with --version')
    .option('--version <id>', 'exact stored version to restore')
    .option('--before <iso>', "restore each file's last version at or before this instant")
    .option('--path <prefix>', 'limit a bulk rollback to this folder and below')
    .option('--in-place', 'upload over the original file instead of writing a copy beside it');
  with_tenant(command).action((options: SharePointRestoreVersionOptions) =>
    execute_sharepoint_restore_version(get_container(), options),
  );
}

function register_sharepoint_list_sites(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('list-sites')
    .description('List all SharePoint sites in the tenant');
  with_tenant(command).action((options: SharePointTenantOptions) =>
    execute_sharepoint_list_sites(get_container(), options),
  );
}

function register_sharepoint_backup(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('backup')
    .description('Back up changed files in a SharePoint site')
    .requiredOption(SITE_FLAG, SITE_DESCRIPTION)
    .option('--full', 'force full crawl ignoring saved delta state')
    .option(
      '--include-subsites',
      'also back up every subsite beneath the site (one snapshot per subsite)',
    );
  with_object_lock(
    command,
    'apply Object Lock default retention for N days (persists on the bucket)',
  );
  with_tenant(command).action((options: SharePointBackupOptions) =>
    execute_sharepoint_backup(get_container(), options),
  );
}

function register_sharepoint_restore(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('restore')
    .description('Restore files from a SharePoint snapshot')
    .requiredOption(SITE_FLAG, SITE_DESCRIPTION)
    .option('--target-site <url-or-id>', 'target site to restore to (defaults to original site)')
    .option(
      '--destination <path>',
      'restore under this folder instead of a generated Restore-<timestamp> root',
    )
    .option('--in-place', 'restore to the original paths, mixing files into live content')
    .option('--name <filename>', 'rename the restored file; requires a single-file restore');
  with_required_snapshot(command, 'snapshot identifier');
  with_file_filter(command, 'restore');
  with_conflict(command);
  with_tenant(command).action((options: SharePointRestoreCommandOptions) =>
    execute_sharepoint_restore(get_container(), options),
  );
}

function register_sharepoint_save(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('save')
    .description('Save files from a SharePoint snapshot to a local zip archive')
    .requiredOption(SITE_FLAG, SITE_DESCRIPTION)
    .option('--skip-verify', 'skip SHA-256 integrity checks');
  with_required_snapshot(command, 'snapshot identifier');
  with_file_filter(command, 'save');
  with_output(command, 'output zip file path');
  with_tenant(command).action((options: SharePointSaveCommandOptions) =>
    execute_sharepoint_save(get_container(), options),
  );
}

function register_sharepoint_verify(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('verify')
    .description('Verify integrity of a SharePoint snapshot')
    .requiredOption(SITE_FLAG, SITE_DESCRIPTION);
  with_required_snapshot(command, 'snapshot identifier');
  with_tenant(command).action((options: SharePointVerifyOptions) =>
    execute_sharepoint_verify(get_container(), options),
  );
}

function register_sharepoint_status(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('status')
    .description('Check whether a site SharePoint backup is up to date')
    .requiredOption(SITE_FLAG, SITE_DESCRIPTION);
  with_tenant(command).action((options: SharePointStatusCommandOptions) =>
    execute_sharepoint_status(get_container(), options),
  );
}

function register_sharepoint_delete(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('delete')
    .description('Delete SharePoint backups for one site, or a single snapshot')
    .requiredOption(SITE_FLAG, SITE_DESCRIPTION);
  with_snapshot(command, 'delete a single snapshot instead of every backup');
  with_yes(command);
  with_tenant(command).action((options: SharePointDeleteOptions) =>
    execute_sharepoint_delete(get_container(), options),
  );
}
