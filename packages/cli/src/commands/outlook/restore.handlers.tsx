import { Box } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { RestoreUseCase, RestoreResult, RestoreOptions } from '@wisecom/atlas-types';
import { RESTORE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { report_run_outcome } from '@/command-run-outcome';
import { run_interruptible } from '@/adapters/interruptible-run';
import type { InterruptGate } from '@/adapters/interrupt-gate';
import { resolve_outlook_scope } from '@/commands/outlook/scope';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { create_transfer_progress } from '@/ui/dashboards/transfer-progress-factory';
import { resolve_owner } from '@/commands/onedrive/command.handlers';
import {
  require_target_for_profile,
  resolve_restore_container,
  target_profile_items,
} from '@/commands/shared/restore-target-container';

export interface OutlookRestoreOptions {
  snapshot?: string;
  tenant?: string;
  mailbox?: string;
  target?: string;
  targetProfile?: string;
  folder?: string;
  message?: string;
  destination?: string;
  startDate?: string;
  endDate?: string;
  includeRecoverableItems?: boolean;
}

const RESTORE_INTERRUPT_MESSAGE = 'Stopping after the current message; the restore will be partial';

/** Validates the scope flags, refusing the combinations that would restore to a guessed mailbox. */
function validate_restore_options(options: OutlookRestoreOptions): void {
  if (!options.snapshot && !options.mailbox) {
    logger.error('Either --snapshot (-s) or --mailbox (-m) is required.');
    process.exit(1);
  }
  if (options.snapshot && options.mailbox) {
    // Restore used to take -m here as a cross-mailbox target, which -T already means and which
    // nothing documented. Guessing between "the snapshot's own mailbox" and "the one named by -m"
    // decides which mailbox receives the mail, so this refuses instead (issue #201).
    logger.error(
      'Pass either --snapshot (-s) or --mailbox (-m), not both. ' +
        'To restore a snapshot into a different mailbox, use --snapshot with --target (-T).',
    );
    process.exit(1);
  }
  if ((options.startDate || options.endDate) && options.snapshot) {
    logger.error('--start-date / --end-date can only be used with --mailbox (-m).');
    process.exit(1);
  }
}

/** Adds the chosen restore folder to the run summary; the generated default is shown at the end. */
function push_destination_item(items: KeyValueItem[], destination: string | undefined): void {
  if (destination !== undefined) items.push({ label: 'Destination', value: destination });
}

/** Parses a YYYY-MM-DD string into a Date at midnight UTC. */
function parse_date(value: string, label: string): Date {
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d.getTime())) {
    logger.error(`Invalid ${label}: "${value}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }
  return d;
}

/** Runs the restore operation and logs the outcome. */
export async function execute_outlook_restore(
  container: Container,
  options: OutlookRestoreOptions,
): Promise<void> {
  validate_restore_options(options);
  require_target_for_profile(options.targetProfile, options.target, '-T/--target');
  const restore_container = resolve_restore_container(container, options.targetProfile);

  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const restore_service = restore_container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('outlook', 'Restore')} />
      <KeyValueList
        items={[
          { label: 'Tenant', value: tenant_id },
          ...target_profile_items(options.targetProfile, restore_container),
        ]}
      />
    </Box>,
  );

  // validate_restore_options has already refused the ambiguous pair, so exactly one is set.
  const scope = resolve_outlook_scope(options);
  if (scope.mode === 'snapshot') {
    return execute_snapshot_restore(restore_container, restore_service, tenant_id, options);
  }
  return execute_mailbox_restore(container, restore_container, restore_service, tenant_id, options);
}

/** Snapshot-mode restore: restore from a single snapshot. */
async function execute_snapshot_restore(
  container: Container,
  service: RestoreUseCase,
  tenant_id: string,
  options: OutlookRestoreOptions,
): Promise<void> {
  const items: KeyValueItem[] = [{ label: 'Snapshot', value: options.snapshot! }];
  if (options.folder) items.push({ label: 'Folder filter', value: options.folder });
  if (options.message) items.push({ label: 'Message', value: options.message });
  // -T is the documented way to redirect a restore. It used to be read only in mailbox mode, so
  // `restore -s <id> -T other@example.com` silently restored to the original mailbox while the
  // undocumented `-m` spelling worked (issue #201).
  if (options.target) items.push({ label: 'Target mailbox', value: options.target });
  push_destination_item(items, options.destination);
  await render_static_view(<KeyValueList items={items} />);

  const restore_options: RestoreOptions = {
    ...(options.folder && { folder_name: options.folder }),
    ...(options.message && { message_ref: options.message }),
    ...(options.target && { target_mailbox: options.target }),
    ...(options.destination !== undefined && { destination: options.destination }),
    create_progress: create_transfer_progress('restored'),
  };

  const result = await run_interruptible(container, RESTORE_INTERRUPT_MESSAGE, (gate) =>
    service.restore_snapshot(tenant_id, options.snapshot!, with_gate(restore_options, gate)),
  );
  if (result !== undefined) await report_restore_result(result);
}

/** Mailbox-mode restore: aggregate all snapshots for a mailbox. */
async function execute_mailbox_restore(
  container: Container,
  restore_container: Container,
  service: RestoreUseCase,
  tenant_id: string,
  options: OutlookRestoreOptions,
): Promise<void> {
  const start_date = options.startDate ? parse_date(options.startDate, '--start-date') : undefined;
  const end_date = options.endDate ? parse_date(options.endDate, '--end-date') : undefined;

  const items: KeyValueItem[] = [{ label: 'Mailbox', value: options.mailbox! }];
  if (start_date) items.push({ label: 'Start date', value: options.startDate! });
  if (end_date) items.push({ label: 'End date', value: options.endDate! });
  if (options.folder) items.push({ label: 'Folder filter', value: options.folder });
  if (options.target) items.push({ label: 'Target mailbox', value: options.target });
  push_destination_item(items, options.destination);
  await render_static_view(<KeyValueList items={items} />);

  const restore_options: RestoreOptions = {
    ...(options.folder && { folder_name: options.folder }),
    ...(options.includeRecoverableItems && { include_recoverable_items: true }),
    ...(start_date && { start_date }),
    ...(end_date && { end_date }),
    ...(options.target && { target_mailbox: options.target }),
    ...(options.destination !== undefined && { destination: options.destination }),
    create_progress: create_transfer_progress('restored'),
  };

  const owner = await resolve_owner(container, tenant_id, options.mailbox!);
  const result = await run_interruptible(restore_container, RESTORE_INTERRUPT_MESSAGE, (gate) =>
    service.restore_mailbox(tenant_id, owner.object_id, with_gate(restore_options, gate)),
  );
  if (result !== undefined) await report_restore_result(result);
}

/** Hands the interrupt gate to the service, so Ctrl+C also ends a Graph wait (issue #682). */
function with_gate(options: RestoreOptions, gate: InterruptGate): RestoreOptions {
  return { ...options, should_interrupt: gate.should_interrupt, abort_signal: gate.abort_signal };
}

/**
 * Prints a human-readable summary of the restore result.
 *
 * Success is decided from `errors`, not from `error_count`. `error_count` counts message-level
 * failures only, while attachment failures land in `errors`, so a run whose only casualties were
 * attachments printed a green summary, printed no error list, and exited 0. The single-message
 * path made it worse by hardcoding `error_count: 0` while still returning attachment errors
 * (issue #359).
 */
async function report_restore_result(result: RestoreResult): Promise<void> {
  const clean =
    result.errors.length === 0 && result.verification_warnings.length === 0 && !result.interrupted;
  if (clean) {
    const entries: SummaryEntry[] = [
      { label: 'messages restored', value: result.restored_count, color: 'green' },
    ];
    if (result.attachment_count > 0) {
      entries.push({ label: 'attachments', value: result.attachment_count, color: 'cyan' });
    }
    await render_static_view(
      <ResultSummary
        entries={entries}
        {...(result.restore_folder_name ? { suffix: `into ${result.restore_folder_name}` } : {})}
      />,
    );
    return;
  }

  logger.warn(`Restored ${result.restored_count} messages`);
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} />);
  }
  // Shared with the OneDrive and SharePoint handlers: a restore that dropped
  // messages is partial (2), not a hard failure (1).
  report_run_outcome(
    {
      errors: result.errors,
      warnings: result.verification_warnings,
      interrupted: result.interrupted,
    },
    'message',
  );
}
