import type { Command } from 'commander';
import type { Container } from 'inversify';
import {
  execute_contacts_backup,
  execute_contacts_restore,
  execute_contacts_verify,
  type ContactsBackupCommandOptions,
  type ContactsRestoreCommandOptions,
  type ContactsVerifyCommandOptions,
} from '@/commands/contacts/command.handlers';
import {
  execute_contacts_delete,
  execute_contacts_list,
  type ContactsDeleteCommandOptions,
  type ContactsListCommandOptions,
} from '@/commands/contacts/data-ops.handlers';
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

/** Registers `atlas contacts` command group. */
export function register_contacts_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('contacts')
    .description('Personal Outlook contacts backup, restore, list, verify, and deletion commands');
  register_contacts_backup(group, get_container);
  register_contacts_restore(group, get_container);
  register_contacts_list(group, get_container);
  register_contacts_verify(group, get_container);
  register_contacts_delete(group, get_container);
}

function register_contacts_backup(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('backup')
    .description('Back up changed personal contacts for one mailbox')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION)
    .option('--full', 'force full crawl ignoring saved delta state');
  with_object_lock(command, 'lock every object this run writes for N days');
  with_tenant(command).action((options: ContactsBackupCommandOptions) =>
    execute_contacts_backup(get_container(), options),
  );
}

function register_contacts_restore(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('restore')
    .description('Restore contacts from a snapshot without overwriting existing contacts')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION)
    .option('-T, --target <email|id>', 'target mailbox (defaults to the source mailbox)');
  with_required_snapshot(command, 'snapshot identifier to restore');
  with_target_profile(command);
  with_tenant(command).action((options: ContactsRestoreCommandOptions) =>
    execute_contacts_restore(get_container(), options),
  );
}

function register_contacts_list(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('list')
    .description('List contacts snapshots for one mailbox')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION);
  with_tenant(command).action((options: ContactsListCommandOptions) =>
    execute_contacts_list(get_container(), options),
  );
}

function register_contacts_verify(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('verify')
    .description('Verify integrity of a contacts snapshot')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION)
    .option(
      '--fast',
      'existence-only checks (no download/decrypt); catches missing objects cheaply',
    );
  with_required_snapshot(command, 'snapshot identifier to verify');
  with_tenant(command).action((options: ContactsVerifyCommandOptions) =>
    execute_contacts_verify(get_container(), options),
  );
}

function register_contacts_delete(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('delete')
    .description('Delete contacts backups for one mailbox, or a single snapshot')
    .requiredOption(MAILBOX_FLAG, MAILBOX_DESCRIPTION);
  with_snapshot(command, 'delete a single snapshot instead of every backup');
  with_yes(command);
  with_tenant(command).action((options: ContactsDeleteCommandOptions) =>
    execute_contacts_delete(get_container(), options),
  );
}
