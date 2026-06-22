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

type ContainerFactory = () => Container;

/** Registers `atlas outlook` command group. */
export function register_outlook_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('outlook')
    .description('Outlook mailbox backup, restore, and management commands');
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
  group
    .command('backup')
    .description('Back up mailboxes from M365 tenant to object storage')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <id>', 'specific mailbox to back up (backs up all if omitted)')
    .option('-f, --folder <name...>', 'specific folder(s) to back up (e.g. -f Inbox "Sent Items")')
    .option('--full', 'force a full backup, ignoring saved delta state from prior runs')
    .option('-P, --page-size <n>', 'Graph API page size per delta request (1-100)', '10')
    .option('--retention-days <n>', 'apply object lock retention for N days')
    .option('--lock-mode <mode>', 'Object Lock mode: governance|compliance')
    .option('--require-immutability', 'fail when immutability cannot be enforced')
    .option('-C, --concurrency <n>', 'parallel mailbox count for tenant backup (default 4)', '4')
    .action((options: OutlookBackupOptions) => execute_outlook_backup(get_container(), options));
}

function register_outlook_verify(group: Command, get_container: ContainerFactory): void {
  group
    .command('verify')
    .description('Verify integrity of a backup snapshot')
    .requiredOption('-s, --snapshot <id>', 'snapshot identifier to verify')
    .requiredOption('-m, --mailbox <email>', 'mailbox that owns the snapshot')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OutlookVerifyOptions) => execute_outlook_verify(get_container(), options));
}

function register_outlook_restore(group: Command, get_container: ContainerFactory): void {
  group
    .command('restore')
    .description('Restore emails from a backup snapshot or full mailbox backup')
    .option('-s, --snapshot <id>', 'restore from a specific snapshot')
    .option('-m, --mailbox <email>', 'restore from all snapshots for this mailbox')
    .option('-T, --target <email>', 'target mailbox (defaults to source mailbox)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-f, --folder <name>', 'restore only messages from this folder')
    .option('--message <ref>', 'restore a single message by # from atlas list, or full ID')
    .option('--start-date <YYYY-MM-DD>', 'include snapshots created on or after this date')
    .option('--end-date <YYYY-MM-DD>', 'include snapshots created on or before this date')
    .action((options: OutlookRestoreOptions) => execute_outlook_restore(get_container(), options));
}

function register_outlook_list(group: Command, get_container: ContainerFactory): void {
  group
    .command('list')
    .description('Browse backed-up data (mailboxes, snapshots, messages)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <email>', 'list snapshots for a specific mailbox')
    .option('-s, --snapshot <id>', 'list messages inside a specific snapshot')
    .option('--all', 'show all messages (default caps at 50)')
    .option('-S, --subjects', 'reveal email subjects (hidden by default for data protection)')
    .action((options: OutlookListOptions) => execute_outlook_list(get_container(), options));
}

function register_outlook_read(group: Command, get_container: ContainerFactory): void {
  group
    .command('read')
    .description('Decrypt and display a single backed-up message')
    .requiredOption('-s, --snapshot <id>', 'snapshot containing the message')
    .requiredOption('--message <ref>', 'message # from atlas list, or full message ID')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--raw', 'output the full JSON blob instead of formatted view')
    .action((options: OutlookReadOptions) => execute_outlook_read(get_container(), options));
}

function register_outlook_save(group: Command, get_container: ContainerFactory): void {
  group
    .command('save')
    .description('Save backed-up emails as EML files in a compressed zip archive')
    .option('-s, --snapshot <id>', 'save from a specific snapshot')
    .option('-m, --mailbox <email>', 'save from all snapshots for this mailbox')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-f, --folder <name>', 'save only messages from this folder')
    .option('--message <ref>', 'save a single message by # from atlas list, or full ID')
    .option('--start-date <YYYY-MM-DD>', 'include snapshots created on or after this date')
    .option('--end-date <YYYY-MM-DD>', 'include snapshots created on or before this date')
    .option('-o, --output <path>', 'output zip file path (default: Restore-<timestamp>.zip)')
    .option('--skip-verify', 'skip SHA-256 integrity checks (faster on low-power systems)')
    .action((options: OutlookSaveOptions) => execute_outlook_save(get_container(), options));
}

function register_outlook_delete(group: Command, get_container: ContainerFactory): void {
  group
    .command('delete')
    .description('Delete backed-up data (mailbox, snapshot, or entire tenant)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <email>', 'delete all data and manifests for a mailbox')
    .option('-s, --snapshot <id>', 'delete a single snapshot manifest')
    .option('--purge', 'delete ALL data in the tenant bucket (irreversible)')
    .option('-y, --yes', 'skip confirmation prompt')
    .action((options: OutlookDeleteOptions) => execute_outlook_delete(get_container(), options));
}

function register_outlook_status(group: Command, get_container: ContainerFactory): void {
  group
    .command('status')
    .description('Check if a mailbox backup is up to date (delta peek, no backup runs)')
    .requiredOption('-m, --mailbox <email>', 'mailbox to check')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: OutlookStatusOptions) => execute_outlook_status(get_container(), options));
}

function register_outlook_mailboxes(group: Command, get_container: ContainerFactory): void {
  group
    .command('mailboxes')
    .description('List tenant mailboxes from Microsoft Graph (live, not from backup catalog)')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('--licensed-only', 'only show mailboxes with an active Exchange Online license')
    .action((options: OutlookMailboxesOptions) =>
      execute_outlook_mailboxes(get_container(), options),
    );
}
