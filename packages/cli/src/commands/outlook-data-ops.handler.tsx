import { existsSync } from 'node:fs';
import { Box } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { SaveUseCase, SaveResult, SaveOptions, DeletionUseCase } from '@wisecom/atlas-types';
import { SAVE_USE_CASE_TOKEN, DELETION_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import {
  confirm_deletion,
  print_delete_result,
  render_delete_banner,
} from '@/commands/deletion-presenter';
import { Banner } from '@/ui/components/banner';
import { ask_confirmation } from '@/ui/components/confirm-prompt';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';
import { create_transfer_progress } from '@/ui/dashboards/transfer-progress-factory';

export interface OutlookSaveOptions {
  snapshot?: string;
  tenant?: string;
  mailbox?: string;
  folder?: string;
  message?: string;
  startDate?: string;
  endDate?: string;
  output?: string;
  skipVerify?: boolean;
}

export interface OutlookDeleteOptions {
  tenant?: string;
  mailbox?: string;
  snapshot?: string;
  yes?: boolean;
}

/** Saves backed-up emails as EML files in a compressed zip archive. */
export async function execute_outlook_save(
  container: Container,
  options: OutlookSaveOptions,
): Promise<void> {
  validate_save_options(options);

  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  const save_service = container.get<SaveUseCase>(SAVE_USE_CASE_TOKEN);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Save" />
      <KeyValueList items={[{ label: 'Tenant', value: tenant_id }]} />
    </Box>,
  );

  const save_options = build_save_options(options);

  if (save_options.output_path && existsSync(save_options.output_path)) {
    const proceed = await ask_confirmation(
      `File "${save_options.output_path}" already exists. Overwrite?`,
      true,
    );
    if (!proceed) {
      logger.info('Cancelled.');
      return;
    }
  }

  if (options.snapshot && !options.mailbox) {
    return execute_snapshot_save(save_service, tenant_id, options, save_options);
  }

  return execute_mailbox_save(save_service, tenant_id, options, save_options);
}

/** Routes to the correct mail deletion scope and asks for confirmation. */
export async function execute_outlook_delete(
  container: Container,
  options: OutlookDeleteOptions,
): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  await render_delete_banner();

  if (!options.mailbox && !options.snapshot) {
    logger.error('Specify one of: --mailbox or --snapshot. Tenant-wide purge is `atlas delete`');
    process.exitCode = 1;
    return;
  }

  const description = options.mailbox
    ? `This will delete all data and manifests for ${options.mailbox}`
    : `This will delete snapshot ${options.snapshot} (data objects are retained for other snapshots)`;
  if (!(await confirm_deletion(description, options.yes))) return;

  const deletion = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  const result = options.mailbox
    ? await deletion.delete_mailbox_data(tenant_id, options.mailbox)
    : await deletion.delete_snapshot(tenant_id, options.snapshot!);
  print_delete_result(result);
}

function validate_save_options(options: OutlookSaveOptions): void {
  if (!options.snapshot && !options.mailbox) {
    logger.error('Either --snapshot (-s) or --mailbox (-m) is required.');
    process.exit(1);
  }
  if ((options.startDate || options.endDate) && options.snapshot && !options.mailbox) {
    logger.error('--start-date / --end-date can only be used with --mailbox (-m).');
    process.exit(1);
  }
}

function parse_date(value: string, label: string): Date {
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d.getTime())) {
    logger.error(`Invalid ${label}: "${value}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }
  return d;
}

function build_save_options(options: OutlookSaveOptions): SaveOptions {
  return {
    ...(options.folder && { folder_name: options.folder }),
    ...(options.message && { message_ref: options.message }),
    ...(options.output && { output_path: options.output }),
    ...(options.skipVerify && { skip_integrity_check: true }),
    ...(options.startDate && { start_date: parse_date(options.startDate, '--start-date') }),
    ...(options.endDate && { end_date: parse_date(options.endDate, '--end-date') }),
    create_progress: create_transfer_progress('saved'),
  };
}

async function execute_snapshot_save(
  service: SaveUseCase,
  tenant_id: string,
  cli_options: OutlookSaveOptions,
  save_options: SaveOptions,
): Promise<void> {
  const items: KeyValueItem[] = [{ label: 'Snapshot', value: cli_options.snapshot! }];
  if (cli_options.folder) items.push({ label: 'Folder filter', value: cli_options.folder });
  if (cli_options.message) items.push({ label: 'Message', value: cli_options.message });
  await render_static_view(<KeyValueList items={items} />);

  const result = await service.save_snapshot(tenant_id, cli_options.snapshot!, save_options);
  await report_save_result(result);
}

async function execute_mailbox_save(
  service: SaveUseCase,
  tenant_id: string,
  cli_options: OutlookSaveOptions,
  save_options: SaveOptions,
): Promise<void> {
  const mailbox_id = cli_options.mailbox!.toLowerCase();
  const items: KeyValueItem[] = [{ label: 'Mailbox', value: mailbox_id }];
  if (cli_options.startDate) items.push({ label: 'Start date', value: cli_options.startDate });
  if (cli_options.endDate) items.push({ label: 'End date', value: cli_options.endDate });
  if (cli_options.folder) items.push({ label: 'Folder filter', value: cli_options.folder });
  await render_static_view(<KeyValueList items={items} />);

  const result = await service.save_mailbox(tenant_id, mailbox_id, save_options);
  await report_save_result(result);
}

async function report_save_result(result: SaveResult): Promise<void> {
  const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);

  if (result.error_count === 0 && result.integrity_failures.length === 0) {
    const entries: SummaryEntry[] = [
      { label: 'messages saved', value: result.saved_count, color: 'green' },
    ];
    if (result.attachment_count > 0) {
      entries.push({ label: 'attachments', value: result.attachment_count, color: 'cyan' });
    }
    await render_static_view(
      <ResultSummary entries={entries} suffix={`${size_mb} MB → ${result.output_path}`} />,
    );
    return;
  }

  if (result.integrity_failures.length > 0) {
    logger.warn(`${result.integrity_failures.length} integrity check failures`);
  }

  if (result.error_count > 0) {
    logger.warn(`Saved ${result.saved_count} messages with ${result.error_count} errors`);
    await render_static_view(<ErrorList errors={result.errors} />);
    process.exitCode = 1;
  }
}
