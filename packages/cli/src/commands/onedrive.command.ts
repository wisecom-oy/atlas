import type { Command } from 'commander';
import type { Container } from 'inversify';
import {
  execute_onedrive_backup,
  execute_onedrive_list_snapshots,
  execute_onedrive_list_versions,
  execute_onedrive_restore,
  execute_onedrive_save,
  execute_onedrive_verify,
  type OneDriveBackupOptions,
  type OneDriveListSnapshotsOptions,
  type OneDriveListVersionsOptions,
  type OneDriveRestoreCommandOptions,
  type OneDriveSaveCommandOptions,
  type OneDriveVerifyOptions,
} from '@/commands/onedrive-command.handlers';

type ContainerFactory = () => Container;

/** Registers `atlas onedrive` command group with backup, list, and verify subcommands. */
export function register_onedrive_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('onedrive')
    .description('OneDrive backup and verification commands');
  register_onedrive_backup(group, get_container);
  register_onedrive_restore(group, get_container);
  register_onedrive_save(group, get_container);
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

function register_onedrive_restore(group: Command, get_container: ContainerFactory): void {
  group
    .command('restore')
    .description('Restore files from a OneDrive snapshot')
    .requiredOption('-o, --owner <id>', 'user email or Entra object ID')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('--target-owner <id>', 'target user email or Entra object ID (defaults to owner)')
    .option('--file-filter <paths...>', 'only restore specific files (by ID or path)')
    .option(
      '-c, --conflict <mode>',
      'file conflict policy: replace, rename, or fail (default: rename)',
    )
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveRestoreCommandOptions) =>
      execute_onedrive_restore(get_container(), options),
    );
}

function register_onedrive_save(group: Command, get_container: ContainerFactory): void {
  group
    .command('save')
    .description('Save files from a OneDrive snapshot to a local zip archive')
    .requiredOption('-o, --owner <id>', 'user email or Entra object ID')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('--file-filter <paths...>', 'only save specific files (by ID or path)')
    .option('-O, --output <path>', 'output zip file path')
    .option('--skip-verify', 'skip SHA-256 integrity checks')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveSaveCommandOptions) =>
      execute_onedrive_save(get_container(), options),
    );
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
    .requiredOption('-o, --owner <id>', 'user email or Entra object ID')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OneDriveVerifyOptions) => execute_onedrive_verify(get_container(), options));
}
