import type { Command } from 'commander';
import type { Container } from 'inversify';
import {
  execute_outlook_backup,
  type OutlookBackupOptions,
} from '@/commands/outlook-backup.handler';
import {
  execute_outlook_restore,
  type OutlookRestoreOptions,
} from '@/commands/outlook-restore.handler';
import {
  execute_outlook_list,
  execute_outlook_read,
  type OutlookListOptions,
  type OutlookReadOptions,
} from '@/commands/outlook-catalog.handler';
import {
  execute_outlook_save,
  execute_outlook_delete,
  type OutlookSaveOptions,
  type OutlookDeleteOptions,
} from '@/commands/outlook-data-ops.handler';
import {
  execute_outlook_verify,
  execute_outlook_status,
  execute_outlook_mailboxes,
  type OutlookVerifyOptions,
  type OutlookStatusOptions,
  type OutlookMailboxesOptions,
} from '@/commands/outlook-mgmt.handler';
import {
  reject_retired_short,
  with_folder,
  with_object_lock,
  with_output,
  with_repeatable_folder,
  with_required_snapshot,
  with_snapshot,
  with_tenant,
  with_yes,
} from '@/commands/shared-options';

type ContainerFactory = () => Container;

/** Registers `atlas outlook` command group. */
export function register_outlook_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('outlook')
    .description(
      'Outlook mailbox backup, restore, save, verify, catalog, status, and deletion commands',
    );
  register_outlook_backup(group, get_container);
  register_outlook_verify(group, get_container);
  register_outlook_restore(group, get_container);
  register_outlook_list(group, get_container);
  register_outlook_read(group, get_container);
  register_outlook_save(group, get_container);
  register_outlook_delete(group, get_container);
  register_outlook_status(group, get_container);
  register_outlook_mailboxes(group, get_container);
}

function register_outlook_backup(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('backup')
    .description('Back up one mailbox from M365 tenant to object storage')
    .requiredOption('-m, --mailbox <id>', 'mailbox to back up')
    .option('--full', 'force a full backup, ignoring saved delta state from prior runs')
    .option('--exclude-junk', 'skip the Junk Email folder (captured by default)')
    .option(
      '--include-recoverable-items',
      'also back up hard-deleted and hold-retained mail from Recoverable Items',
    )
    .option('-P, --page-size <n>', 'Graph API page size per delta request (1-100)', '10');
  with_repeatable_folder(
    command,
    'folder to back up; repeat for more (e.g. -f Inbox -f "Sent Items")',
  );
  with_object_lock(command, 'apply object lock retention for N days');
  with_tenant(command).action((options: OutlookBackupOptions) =>
    execute_outlook_backup(get_container(), options),
  );
}

function register_outlook_verify(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('verify')
    .description('Verify integrity of a backup snapshot')
    .requiredOption('-m, --mailbox <email>', 'mailbox that owns the snapshot')
    .option(
      '--fast',
      'existence-only checks (no download/decrypt); catches missing objects cheaply',
    );
  with_required_snapshot(command, 'snapshot identifier to verify');
  with_tenant(command).action((options: OutlookVerifyOptions) =>
    execute_outlook_verify(get_container(), options),
  );
}

function register_outlook_restore(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('restore')
    .description('Restore emails from a backup snapshot or full mailbox backup')
    .option('-m, --mailbox <email>', 'restore from all snapshots for this mailbox')
    .option('-T, --target <email>', 'target mailbox (defaults to source mailbox)')
    .option('--message <ref>', 'restore a single message by # from atlas list, or full ID')
    .option('--start-date <YYYY-MM-DD>', 'include snapshots created on or after this date')
    .option('--end-date <YYYY-MM-DD>', 'include snapshots created on or before this date')
    .option(
      '--include-recoverable-items',
      'include hard-deleted and hold-retained mail captured from Recoverable Items',
    );
  with_snapshot(command, 'restore from a specific snapshot');
  with_folder(command, 'restore only messages from this folder');
  with_tenant(command).action((options: OutlookRestoreOptions) =>
    execute_outlook_restore(get_container(), options),
  );
}

function register_outlook_list(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('list')
    .description('Browse backed-up data (mailboxes, snapshots, messages)')
    .option('-m, --mailbox <email>', 'list snapshots for a specific mailbox')
    .option('--all', 'show all messages (default caps at 50)')
    .option('-S, --subjects', 'reveal email subjects (hidden by default for data protection)');
  with_snapshot(command, 'list messages inside a specific snapshot');
  with_tenant(command).action((options: OutlookListOptions) =>
    execute_outlook_list(get_container(), options),
  );
}

function register_outlook_read(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('read')
    .description('Decrypt and display a single backed-up message')
    .requiredOption('--message <ref>', 'message # from atlas list, or full message ID')
    .option('--raw', 'output the full JSON blob instead of formatted view');
  with_required_snapshot(command, 'snapshot containing the message');
  with_tenant(command).action((options: OutlookReadOptions) =>
    execute_outlook_read(get_container(), options),
  );
}

function register_outlook_save(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('save')
    .description('Save backed-up emails as EML files in a compressed zip archive')
    .option('-m, --mailbox <email>', 'save from all snapshots for this mailbox')
    .option('--message <ref>', 'save a single message by # from atlas list, or full ID')
    .option('--start-date <YYYY-MM-DD>', 'include snapshots created on or after this date')
    .option('--end-date <YYYY-MM-DD>', 'include snapshots created on or before this date')
    .option('--skip-verify', 'skip SHA-256 integrity checks (faster on low-power systems)')
    .option(
      '--include-recoverable-items',
      'include hard-deleted and hold-retained mail captured from Recoverable Items',
    );
  with_snapshot(command, 'save from a specific snapshot');
  with_folder(command, 'save only messages from this folder');
  with_output(command, 'output zip file path (default: Restore-<timestamp>.zip)');
  // `-o` was this command's own spelling of --output and is the owner everywhere else.
  reject_retired_short(command, '-o', '--output');
  with_tenant(command).action((options: OutlookSaveOptions) =>
    execute_outlook_save(get_container(), options),
  );
}

function register_outlook_delete(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('delete')
    .description('Delete backed-up mail data (one mailbox or one snapshot)')
    .option('-m, --mailbox <email>', 'delete all data and manifests for a mailbox');
  with_snapshot(command, 'delete a single snapshot manifest');
  with_yes(command);
  with_tenant(command).action((options: OutlookDeleteOptions) =>
    execute_outlook_delete(get_container(), options),
  );
}

function register_outlook_status(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('status')
    .description('Check if a mailbox backup is up to date (delta peek, no backup runs)')
    .requiredOption('-m, --mailbox <email>', 'mailbox to check');
  with_tenant(command).action((options: OutlookStatusOptions) =>
    execute_outlook_status(get_container(), options),
  );
}

function register_outlook_mailboxes(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('mailboxes')
    .description('List tenant mailboxes from Microsoft Graph (live, not from backup catalog)')
    .option('--licensed-only', 'only show mailboxes with an active Exchange Online license');
  with_tenant(command).action((options: OutlookMailboxesOptions) =>
    execute_outlook_mailboxes(get_container(), options),
  );
}
