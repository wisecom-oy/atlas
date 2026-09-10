import type { Command } from 'commander';
import type { Container } from 'inversify';
import {
  execute_onedrive_backup,
  execute_onedrive_restore,
  execute_onedrive_save,
  execute_onedrive_verify,
  type OneDriveBackupOptions,
  type OneDriveRestoreCommandOptions,
  type OneDriveSaveCommandOptions,
  type OneDriveVerifyOptions,
} from '@/commands/onedrive-command.handlers';
import {
  execute_onedrive_list_snapshots,
  execute_onedrive_list_versions,
  type OneDriveListSnapshotsOptions,
  type OneDriveListVersionsOptions,
} from '@/commands/onedrive-catalog-command.handlers';
import {
  execute_onedrive_restore_version,
  type OneDriveRestoreVersionOptions,
} from '@/commands/drive-version-restore.handlers';
import {
  execute_onedrive_delete,
  execute_onedrive_status,
  type OneDriveDeleteOptions,
  type OneDriveStatusCommandOptions,
} from '@/commands/onedrive-data-ops.handlers';
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

const OWNER_FLAG = '-o, --owner <id>';
const OWNER_DESCRIPTION = 'user email or Entra object ID';

/** Registers `atlas onedrive` command group. */
export function register_onedrive_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('onedrive')
    .description('OneDrive backup, restore, save, verify, catalog, status, and deletion commands');
  register_onedrive_backup(group, get_container);
  register_onedrive_restore(group, get_container);
  register_onedrive_save(group, get_container);
  register_onedrive_list_snapshots(group, get_container);
  register_onedrive_list_versions(group, get_container);
  register_onedrive_restore_version(group, get_container);
  register_onedrive_verify(group, get_container);
  register_onedrive_status(group, get_container);
  register_onedrive_delete(group, get_container);
}

function register_onedrive_backup(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('backup')
    .description('Back up changed OneDrive files for one user')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION)
    .option('--full', 'force full crawl ignoring saved delta state')
    .option(
      '--folder <path>',
      'only back up this folder and its subfolders (e.g. /Projects); changing it forces a full crawl',
    );
  with_object_lock(
    command,
    'apply Object Lock default retention for N days (persists on the bucket)',
  );
  with_tenant(command).action((options: OneDriveBackupOptions) =>
    execute_onedrive_backup(get_container(), options),
  );
}

function register_onedrive_restore(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('restore')
    .description('Restore files from a OneDrive snapshot')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION)
    .option('--target-owner <id>', 'target user email or Entra object ID (defaults to owner)')
    .option(
      '--destination <path>',
      'restore under this folder instead of a generated Restore-<timestamp> root',
    )
    .option('--in-place', 'restore to the original paths, mixing files into live content')
    .option('--name <filename>', 'rename the restored file; requires a single-file restore');
  with_required_snapshot(command, 'snapshot identifier');
  with_file_filter(command, 'restore');
  with_conflict(command);
  with_tenant(command).action((options: OneDriveRestoreCommandOptions) =>
    execute_onedrive_restore(get_container(), options),
  );
}

function register_onedrive_save(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('save')
    .description('Save files from a OneDrive snapshot to a local zip archive')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION)
    .option('--skip-verify', 'skip SHA-256 integrity checks');
  with_required_snapshot(command, 'snapshot identifier');
  with_file_filter(command, 'save');
  with_output(command, 'output zip file path');
  with_tenant(command).action((options: OneDriveSaveCommandOptions) =>
    execute_onedrive_save(get_container(), options),
  );
}

function register_onedrive_list_snapshots(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('list-snapshots')
    .description('List OneDrive snapshots for a user')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION);
  with_tenant(command).action((options: OneDriveListSnapshotsOptions) =>
    execute_onedrive_list_snapshots(get_container(), options),
  );
}

function register_onedrive_list_versions(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('list-versions')
    .description('List all backed-up versions for a specific file')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION)
    .requiredOption('-f, --file <ref>', 'file ID or path');
  with_tenant(command).action((options: OneDriveListVersionsOptions) =>
    execute_onedrive_list_versions(get_container(), options),
  );
}

function register_onedrive_restore_version(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('restore-version')
    .description('Restore stored file versions back into OneDrive')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION)
    .option('-f, --file <ref>', 'file ID or path; required with --version')
    .option('--version <id>', 'exact stored version to restore')
    .option('--before <iso>', "restore each file's last version at or before this instant")
    .option('--path <prefix>', 'limit a bulk rollback to this folder and below')
    .option('--in-place', 'upload over the original file instead of writing a copy beside it');
  with_tenant(command).action((options: OneDriveRestoreVersionOptions) =>
    execute_onedrive_restore_version(get_container(), options),
  );
}

function register_onedrive_verify(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('verify')
    .description('Verify integrity of a OneDrive snapshot')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION);
  with_required_snapshot(command, 'snapshot identifier');
  with_tenant(command).action((options: OneDriveVerifyOptions) =>
    execute_onedrive_verify(get_container(), options),
  );
}

function register_onedrive_status(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('status')
    .description('Check whether an owner OneDrive backup is up to date')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION);
  with_tenant(command).action((options: OneDriveStatusCommandOptions) =>
    execute_onedrive_status(get_container(), options),
  );
}

function register_onedrive_delete(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('delete')
    .description('Delete OneDrive backups for one owner, or a single snapshot')
    .requiredOption(OWNER_FLAG, OWNER_DESCRIPTION);
  with_snapshot(command, 'delete a single snapshot instead of every backup');
  with_yes(command);
  with_tenant(command).action((options: OneDriveDeleteOptions) =>
    execute_onedrive_delete(get_container(), options),
  );
}
