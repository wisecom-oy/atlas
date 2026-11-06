import type { Command } from 'commander';
import type { Container } from 'inversify';
import {
  execute_calendar_backup,
  execute_calendar_restore,
  execute_calendar_verify,
  type CalendarBackupCommandOptions,
  type CalendarRestoreCommandOptions,
  type CalendarVerifyCommandOptions,
} from '@/commands/calendar/command.handlers';
import {
  execute_calendar_delete,
  execute_calendar_list,
  type CalendarDeleteCommandOptions,
  type CalendarListCommandOptions,
} from '@/commands/calendar/data-ops.handlers';
import {
  with_object_lock,
  with_required_snapshot,
  with_snapshot,
  with_target_profile,
  with_tenant,
  with_yes,
} from '@/commands/shared/shared-options';

type ContainerFactory = () => Container;

const MAILBOX_FLAG = '-m, --mailbox <email|id>';
const MAILBOX_DESCRIPTION = 'mailbox (user email or Entra object ID)';

/** Registers `atlas calendar` command group. */
export function register_calendar_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('calendar')
    .description('Outlook calendar backup, restore, list, verify, and deletion commands');
  register_calendar_backup(group, get_container);
  register_calendar_restore(group, get_container);
  register_calendar_list(group, get_container);
  register_calendar_verify(group, get_container);
  register_calendar_delete(group, get_container);
}

function register_calendar_backup(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('backup')
    .description('Back up changed calendar events for one mailbox')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION)
    .option('--full', 'force full crawl ignoring saved delta state');
  with_object_lock(command, 'lock every object this run writes for N days');
  with_tenant(command).action((options: CalendarBackupCommandOptions) =>
    execute_calendar_backup(get_container(), options),
  );
}

function register_calendar_restore(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('restore')
    .description('Restore calendar events from a snapshot without overwriting existing events')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION)
    .option('-T, --target <email|id>', 'target mailbox (defaults to the source mailbox)');
  with_required_snapshot(command, 'snapshot identifier to restore');
  with_target_profile(command);
  with_tenant(command).action((options: CalendarRestoreCommandOptions) =>
    execute_calendar_restore(get_container(), options),
  );
}

function register_calendar_list(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('list')
    .description('List calendar snapshots for one mailbox')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION);
  with_tenant(command).action((options: CalendarListCommandOptions) =>
    execute_calendar_list(get_container(), options),
  );
}

function register_calendar_verify(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('verify')
    .description('Verify integrity of a calendar snapshot')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION)
    .option(
      '--fast',
      'existence-only checks (no download/decrypt); catches missing objects cheaply',
    );
  with_required_snapshot(command, 'snapshot identifier to verify');
  with_tenant(command).action((options: CalendarVerifyCommandOptions) =>
    execute_calendar_verify(get_container(), options),
  );
}

function register_calendar_delete(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('delete')
    .description('Delete calendar backups for one mailbox, or a single snapshot')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION);
  with_snapshot(command, 'delete a single snapshot instead of every backup');
  with_yes(command);
  with_tenant(command).action((options: CalendarDeleteCommandOptions) =>
    execute_calendar_delete(get_container(), options),
  );
}
