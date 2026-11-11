import type { Container } from 'inversify';
import { Box } from 'ink';
import { report_unreadable_keys } from '@/command-unreadable-objects';
import { logger } from '@wisecom/atlas-core';
import type {
  ContactsBackupUseCase,
  ContactsRestoreUseCase,
  ContactsVerificationUseCase,
} from '@wisecom/atlas-types';
import {
  CONTACTS_BACKUP_USE_CASE_TOKEN,
  CONTACTS_RESTORE_USE_CASE_TOKEN,
  CONTACTS_VERIFICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { create_backup_progress } from '@/ui/dashboards/backup-progress-factory';
import { build_object_lock_request } from '@/command-object-lock';
import { report_run_outcome } from '@/command-run-outcome';
import { run_interruptible } from '@/adapters/interruptible-run';
import {
  resolve_owner,
  resolve_restore_target,
  resolve_tenant_id,
  type ResolvedOwner,
} from '@/commands/onedrive/command.handlers';
import {
  require_target_for_profile,
  resolve_restore_container,
  target_profile_items,
} from '@/commands/shared/restore-target-container';

export interface ContactsTenantOptions {
  tenant?: string;
}

export interface ContactsBackupCommandOptions extends ContactsTenantOptions {
  mailbox: string;
  full?: boolean;
  retentionDays?: string;
  lockMode?: string;
}

export interface ContactsRestoreCommandOptions extends ContactsTenantOptions {
  mailbox: string;
  snapshot: string;
  target?: string;
  targetProfile?: string;
}

export interface ContactsVerifyCommandOptions extends ContactsTenantOptions {
  mailbox: string;
  snapshot: string;
  fast?: boolean;
}

const BACKUP_INTERRUPT_MESSAGE =
  '[!] Stopping after the current contact; the delta cursor is not advanced for an interrupted run';
const RESTORE_INTERRUPT_MESSAGE =
  '[!] Stopping after the current contact; the restore will be partial';

function mailbox_label(mailbox: ResolvedOwner): string {
  return mailbox.display_name
    ? `${mailbox.display_name} (${mailbox.object_id})`
    : mailbox.object_id;
}

/** Backs up one mailbox's personal contacts and reports the resulting snapshot. */
export async function execute_contacts_backup(
  container: Container,
  options: ContactsBackupCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  // Built before the Graph lookup: invalid Object Lock flags must fail without a network call.
  const object_lock_request = build_object_lock_request(options);
  const mailbox = await resolve_owner(container, tenant_id, options.mailbox);
  const backup = container.get<ContactsBackupUseCase>(CONTACTS_BACKUP_USE_CASE_TOKEN);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('contacts', 'Backup')} />
      <KeyValueList items={[{ label: 'Mailbox', value: mailbox_label(mailbox) }]} />
    </Box>,
  );

  const result = await run_interruptible(container, BACKUP_INTERRUPT_MESSAGE, (gate) =>
    backup.backup_contacts(tenant_id, mailbox.object_id, {
      force_full: options.full ?? false,
      object_lock_request,
      create_progress: create_backup_progress({
        rate: 'folders/s',
        extra: 'photos',
        row_noun: 'folder',
      }),
      should_interrupt: gate.should_interrupt,
      abort_signal: gate.abort_signal,
    }),
  );
  if (result === undefined) return;

  const { summary } = result;
  if (result.snapshot) {
    logger.success(`Snapshot ${result.snapshot.snapshot_id} created`);
    const counters: SummaryEntry[] = [
      { label: 'changed', value: summary.contacts_changed, color: 'cyan' },
      { label: 'stored', value: summary.objects_stored, color: 'green' },
    ];
    if (summary.contacts_removed > 0) {
      counters.push({ label: 'removed', value: summary.contacts_removed, color: 'red' });
    }
    await render_static_view(<ResultSummary entries={counters} />);
  } else if (summary.no_snapshot_reason === 'no_content') {
    logger.warn('No contacts found. Nothing was backed up and no snapshot exists.');
  } else if (summary.no_snapshot_reason === 'no_changes') {
    logger.info('No contact changes detected. Snapshot skipped.');
  } else {
    logger.warn('No snapshot created: the run was interrupted or every change failed.');
  }

  if (summary.healthy) {
    logger.success('Status: HEALTHY');
  } else {
    logger.error('Status: UNHEALTHY');
  }
  report_run_outcome(
    { errors: summary.errors, warnings: [], interrupted: result.interrupted },
    'contact',
  );
  report_unreadable_keys(summary.unreadable_keys);
}

/** Restores a contacts snapshot into the source or a target mailbox, skipping contacts that already exist. */
export async function execute_contacts_restore(
  container: Container,
  options: ContactsRestoreCommandOptions,
): Promise<void> {
  require_target_for_profile(options.targetProfile, options.target, '-T/--target');
  const restore_container = resolve_restore_container(container, options.targetProfile);
  const tenant_id = resolve_tenant_id(container, options);
  const mailbox = await resolve_owner(container, tenant_id, options.mailbox);
  const target = options.target
    ? await resolve_restore_target(restore_container, tenant_id, options.target)
    : undefined;
  const restore = restore_container.get<ContactsRestoreUseCase>(CONTACTS_RESTORE_USE_CASE_TOKEN);

  const result = await run_interruptible(restore_container, RESTORE_INTERRUPT_MESSAGE, (gate) =>
    restore.restore_contacts(tenant_id, mailbox.object_id, {
      snapshot_id: options.snapshot,
      ...(target ? { target_mailbox_id: target.object_id } : {}),
      should_interrupt: gate.should_interrupt,
      abort_signal: gate.abort_signal,
    }),
  );
  if (result === undefined) return;

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('contacts', 'Restore')} />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Contacts restored', value: String(result.contacts_restored) },
          { label: 'Contacts skipped (already present)', value: String(result.contacts_skipped) },
          { label: 'Folders created', value: String(result.folders_created) },
          ...target_profile_items(options.targetProfile, restore_container),
        ]}
      />
    </Box>,
  );
  report_run_outcome(
    { errors: result.errors, warnings: [], interrupted: result.interrupted },
    'contact',
  );
}

/** Verifies every object a contacts snapshot references, optionally existence-only. */
export async function execute_contacts_verify(
  container: Container,
  options: ContactsVerifyCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const mailbox = await resolve_owner(container, tenant_id, options.mailbox);
  const verifier = container.get<ContactsVerificationUseCase>(CONTACTS_VERIFICATION_USE_CASE_TOKEN);
  const result = await verifier.verify_contacts_snapshot(
    tenant_id,
    mailbox.object_id,
    options.snapshot,
    { fast: options.fast === true },
  );

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('contacts', 'Verify')} />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Checked', value: String(result.total_checked) },
          { label: 'Passed', value: String(result.passed) },
          { label: 'Unverifiable', value: String(result.unverifiable.length) },
        ]}
      />
    </Box>,
  );

  if (result.failed.length > 0) {
    logger.error(`Failures: ${result.failed.length}`);
    await render_static_view(<ErrorList errors={result.failed} max={result.failed.length} />);
    process.exitCode = 1;
  } else if (result.interrupted) {
    logger.warn('Verification interrupted before every entry was checked');
    process.exitCode = 2;
  } else {
    logger.success(`All ${result.total_checked} entries passed verification`);
  }
}
