import { existsSync } from 'node:fs';
import { Box } from 'ink';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type {
  SaveUseCase,
  SaveResult,
  SaveOptions,
  DeletionUseCase,
  DeletionResult,
} from '@wisecom/atlas-types';
import { SAVE_USE_CASE_TOKEN, DELETION_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
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
  purge?: boolean;
  yes?: boolean;
}

type DeleteScope = 'mailbox' | 'snapshot' | 'purge';

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

/** Routes to the correct deletion scope and asks for confirmation. */
export async function execute_outlook_delete(
  container: Container,
  options: OutlookDeleteOptions,
): Promise<void> {
  const tenant_id = options.tenant ?? container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
  await render_static_view(<Banner title="Atlas Delete" />);

  const { scope, description } = determine_scope(options, tenant_id);
  if (!scope) {
    logger.error('Specify one of: --mailbox, --snapshot, or --purge');
    process.exitCode = 1;
    return;
  }

  logger.warn(description);

  if (!options.yes) {
    const confirmed = await ask_confirmation('Continue?', false);
    if (!confirmed) {
      logger.info('Aborted');
      return;
    }
  }

  const deletion = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  const result = await dispatch_deletion(deletion, scope, tenant_id, options);
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

/** Determines which deletion path to take and builds a human-readable warning. */
function determine_scope(
  options: OutlookDeleteOptions,
  tenant_id: string,
): { scope: DeleteScope | undefined; description: string } {
  if (options.purge) {
    return {
      scope: 'purge',
      description: `This will delete ALL data for tenant ${tenant_id} (data, manifests, encryption keys)`,
    };
  }
  if (options.mailbox) {
    return {
      scope: 'mailbox',
      description: `This will delete all data and manifests for ${options.mailbox}`,
    };
  }
  if (options.snapshot) {
    return {
      scope: 'snapshot',
      description: `This will delete snapshot ${options.snapshot} (data objects are retained for other snapshots)`,
    };
  }
  return { scope: undefined, description: '' };
}

/** Dispatches to the correct DeletionService method. */
async function dispatch_deletion(
  deletion: DeletionUseCase,
  scope: DeleteScope,
  tenant_id: string,
  options: OutlookDeleteOptions,
): Promise<DeletionResult> {
  switch (scope) {
    case 'mailbox':
      return deletion.delete_mailbox_data(tenant_id, options.mailbox!);
    case 'snapshot':
      return deletion.delete_snapshot(tenant_id, options.snapshot!);
    case 'purge':
      return deletion.purge_tenant(tenant_id);
  }
}

/** Prints a summary of what was deleted. */
function print_delete_result(result: DeletionResult): void {
  const no_deleted = result.deleted_objects === 0 && result.deleted_manifests === 0;
  const no_retained = result.retained_objects === 0 && result.retained_manifests === 0;
  const no_failed = result.failed_objects === 0 && result.failed_manifests === 0;

  if (no_deleted && no_retained && no_failed) {
    logger.warn('Nothing to delete');
    return;
  }

  logger.success(
    `Deleted ${result.deleted_objects} object(s), ${result.deleted_manifests} manifest(s)`,
  );
  logger.info(
    `Retained and not deleted: ${result.retained_objects} object(s), ` +
      `${result.retained_manifests} manifest(s)`,
  );
  logger.info(
    `Failed for other reasons: ${result.failed_objects} object(s), ` +
      `${result.failed_manifests} manifest(s)`,
  );

  if (!no_retained || !no_failed) {
    process.exitCode = 1;
  }
}
