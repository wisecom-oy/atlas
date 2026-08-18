import { Box } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { RestoreUseCase, RestoreResult, RestoreOptions } from '@wisecom/atlas-types';
import { RESTORE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { create_transfer_progress } from '@/ui/dashboards/transfer-progress-factory';

export interface OutlookRestoreOptions {
  snapshot?: string;
  tenant?: string;
  mailbox?: string;
  target?: string;
  folder?: string;
  message?: string;
  startDate?: string;
  endDate?: string;
}

/** Validates that exactly one of --snapshot or --mailbox is provided. */
function validate_restore_options(options: OutlookRestoreOptions): void {
  if (!options.snapshot && !options.mailbox) {
    logger.error('Either --snapshot (-s) or --mailbox (-m) is required.');
    process.exit(1);
  }
  if (options.snapshot && options.mailbox && !options.target) {
    // When both -s and -m given, -m acts as target override (legacy behavior)
  }
  if ((options.startDate || options.endDate) && options.snapshot && !options.mailbox) {
    logger.error('--start-date / --end-date can only be used with --mailbox (-m).');
    process.exit(1);
  }
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

  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const restore_service = container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Restore" />
      <KeyValueList items={[{ label: 'Tenant', value: tenant_id }]} />
    </Box>,
  );

  if (options.snapshot && !options.mailbox) {
    return execute_snapshot_restore(restore_service, tenant_id, options);
  }

  if (options.mailbox && !options.snapshot) {
    return execute_mailbox_restore(restore_service, tenant_id, options);
  }

  // Both -s and -m: legacy behavior where -m is target override
  return execute_snapshot_restore(restore_service, tenant_id, options);
}

/** Snapshot-mode restore: restore from a single snapshot. */
async function execute_snapshot_restore(
  service: RestoreUseCase,
  tenant_id: string,
  options: OutlookRestoreOptions,
): Promise<void> {
  const items: KeyValueItem[] = [{ label: 'Snapshot', value: options.snapshot! }];
  if (options.folder) items.push({ label: 'Folder filter', value: options.folder });
  if (options.message) items.push({ label: 'Message', value: options.message });
  if (options.mailbox) items.push({ label: 'Target mailbox', value: options.mailbox });
  await render_static_view(<KeyValueList items={items} />);

  const restore_options: RestoreOptions = {
    ...(options.folder && { folder_name: options.folder }),
    ...(options.message && { message_ref: options.message }),
    ...(options.mailbox && { target_mailbox: options.mailbox }),
    create_progress: create_transfer_progress('restored'),
  };

  const result = await service.restore_snapshot(tenant_id, options.snapshot!, restore_options);
  await report_restore_result(result);
}

/** Mailbox-mode restore: aggregate all snapshots for a mailbox. */
async function execute_mailbox_restore(
  service: RestoreUseCase,
  tenant_id: string,
  options: OutlookRestoreOptions,
): Promise<void> {
  const mailbox_id = options.mailbox!.toLowerCase();

  const start_date = options.startDate ? parse_date(options.startDate, '--start-date') : undefined;
  const end_date = options.endDate ? parse_date(options.endDate, '--end-date') : undefined;

  const items: KeyValueItem[] = [{ label: 'Mailbox', value: mailbox_id }];
  if (start_date) items.push({ label: 'Start date', value: options.startDate! });
  if (end_date) items.push({ label: 'End date', value: options.endDate! });
  if (options.folder) items.push({ label: 'Folder filter', value: options.folder });
  if (options.target) items.push({ label: 'Target mailbox', value: options.target });
  await render_static_view(<KeyValueList items={items} />);

  const restore_options: RestoreOptions = {
    ...(options.folder && { folder_name: options.folder }),
    ...(start_date && { start_date }),
    ...(end_date && { end_date }),
    ...(options.target && { target_mailbox: options.target }),
    create_progress: create_transfer_progress('restored'),
  };

  const result = await service.restore_mailbox(tenant_id, mailbox_id, restore_options);
  await report_restore_result(result);
}

/** Prints a human-readable summary of the restore result. */
async function report_restore_result(result: RestoreResult): Promise<void> {
  if (result.error_count === 0) {
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

  logger.warn(`Restored ${result.restored_count} messages with ${result.error_count} errors`);
  await render_static_view(<ErrorList errors={result.errors} />);
  process.exitCode = 1;
}
