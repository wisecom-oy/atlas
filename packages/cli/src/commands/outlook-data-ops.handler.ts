import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
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

  const tenant_id = resolve_save_tenant_id(container, options);
  const save_service = container.get<SaveUseCase>(SAVE_USE_CASE_TOKEN);

  logger.banner('Atlas Save');
  logger.info(`Tenant: ${tenant_id}`);

  const save_options = build_save_options(options);

  if (save_options.output_path && existsSync(save_options.output_path)) {
    const proceed = await confirm_overwrite(save_options.output_path);
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
  const tenant_id = resolve_delete_tenant_id(container, options);
  logger.banner('Atlas Delete');

  const { scope, description } = determine_scope(options, tenant_id);
  if (!scope) {
    logger.error('Specify one of: --mailbox, --snapshot, or --purge');
    process.exitCode = 1;
    return;
  }

  logger.warn(description);

  if (!options.yes) {
    const confirmed = await ask_confirmation();
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

function resolve_save_tenant_id(container: Container, options: OutlookSaveOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

function resolve_delete_tenant_id(container: Container, options: OutlookDeleteOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

function parse_date(value: string, label: string): Date {
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d.getTime())) {
    logger.error(`Invalid ${label}: "${value}". Expected YYYY-MM-DD.`);
    process.exit(1);
  }
  return d;
}

async function confirm_overwrite(file_path: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`File "${file_path}" already exists. Overwrite? [Y/n] `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

function build_save_options(options: OutlookSaveOptions): SaveOptions {
  return {
    ...(options.folder && { folder_name: options.folder }),
    ...(options.message && { message_ref: options.message }),
    ...(options.output && { output_path: options.output }),
    ...(options.skipVerify && { skip_integrity_check: true }),
    ...(options.startDate && { start_date: parse_date(options.startDate, '--start-date') }),
    ...(options.endDate && { end_date: parse_date(options.endDate, '--end-date') }),
  };
}

async function execute_snapshot_save(
  service: SaveUseCase,
  tenant_id: string,
  cli_options: OutlookSaveOptions,
  save_options: SaveOptions,
): Promise<void> {
  logger.info(`Snapshot: ${chalk.cyan(cli_options.snapshot!)}`);
  if (cli_options.folder) logger.info(`Folder filter: ${chalk.cyan(cli_options.folder)}`);
  if (cli_options.message) logger.info(`Message: ${chalk.cyan(cli_options.message)}`);

  const result = await service.save_snapshot(tenant_id, cli_options.snapshot!, save_options);
  report_save_result(result);
}

async function execute_mailbox_save(
  service: SaveUseCase,
  tenant_id: string,
  cli_options: OutlookSaveOptions,
  save_options: SaveOptions,
): Promise<void> {
  const mailbox_id = cli_options.mailbox!.toLowerCase();
  logger.info(`Mailbox: ${chalk.cyan(mailbox_id)}`);

  if (cli_options.startDate) logger.info(`Start date: ${chalk.cyan(cli_options.startDate)}`);
  if (cli_options.endDate) logger.info(`End date:   ${chalk.cyan(cli_options.endDate)}`);
  if (cli_options.folder) logger.info(`Folder filter: ${chalk.cyan(cli_options.folder)}`);

  const result = await service.save_mailbox(tenant_id, mailbox_id, save_options);
  report_save_result(result);
}

function report_save_result(result: SaveResult): void {
  const size_mb = (result.total_bytes / (1024 * 1024)).toFixed(1);
  const att_info =
    result.attachment_count > 0
      ? ` + ${chalk.cyan(String(result.attachment_count))} attachments`
      : '';

  if (result.error_count === 0 && result.integrity_failures.length === 0) {
    logger.success(
      `Saved ${chalk.green(String(result.saved_count))} messages${att_info}` +
        ` (${chalk.cyan(size_mb + ' MB')}) to ${chalk.cyan(result.output_path)}`,
    );
    return;
  }

  if (result.integrity_failures.length > 0) {
    logger.warn(
      `${chalk.yellow(String(result.integrity_failures.length))} integrity check failures`,
    );
  }

  if (result.error_count > 0) {
    logger.warn(
      `Saved ${result.saved_count} messages with ` +
        `${chalk.yellow(String(result.error_count))} errors`,
    );
    for (const err of result.errors.slice(0, 10)) {
      logger.error(`  - ${err}`);
    }
    if (result.errors.length > 10) {
      logger.error(`  ... and ${result.errors.length - 10} more`);
    }
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

/** Prompts "Continue? [y/N]" and returns true only on explicit "y". */
function ask_confirmation(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    rl.question(chalk.yellow('  Continue? [y/N] '), (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
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
