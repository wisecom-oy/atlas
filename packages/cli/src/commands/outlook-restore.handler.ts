import chalk from 'chalk';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@atlas/core';
import { ATLAS_CONFIG_TOKEN } from '@atlas/core';
import type { RestoreUseCase, RestoreResult, RestoreOptions } from '@atlas/types';
import { RESTORE_USE_CASE_TOKEN } from '@atlas/types';
import { logger } from '@atlas/core';

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

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: OutlookRestoreOptions): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
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

  const tenant_id = resolve_tenant_id(container, options);
  const restore_service = container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);

  logger.banner('Atlas Restore');
  logger.info(`Tenant:  ${tenant_id}`);

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
  logger.info(`Snapshot: ${chalk.cyan(options.snapshot!)}`);
  if (options.folder) logger.info(`Folder filter: ${chalk.cyan(options.folder)}`);
  if (options.message) logger.info(`Message: ${chalk.cyan(options.message)}`);
  if (options.mailbox) logger.info(`Target mailbox: ${chalk.cyan(options.mailbox)}`);

  const restore_options: RestoreOptions = {
    ...(options.folder && { folder_name: options.folder }),
    ...(options.message && { message_ref: options.message }),
    ...(options.mailbox && { target_mailbox: options.mailbox }),
  };

  const result = await service.restore_snapshot(tenant_id, options.snapshot!, restore_options);
  report_restore_result(result);
}

/** Mailbox-mode restore: aggregate all snapshots for a mailbox. */
async function execute_mailbox_restore(
  service: RestoreUseCase,
  tenant_id: string,
  options: OutlookRestoreOptions,
): Promise<void> {
  const mailbox_id = options.mailbox!.toLowerCase();
  logger.info(`Mailbox: ${chalk.cyan(mailbox_id)}`);

  const start_date = options.startDate ? parse_date(options.startDate, '--start-date') : undefined;
  const end_date = options.endDate ? parse_date(options.endDate, '--end-date') : undefined;

  if (start_date) logger.info(`Start date: ${chalk.cyan(options.startDate!)}`);
  if (end_date) logger.info(`End date:   ${chalk.cyan(options.endDate!)}`);
  if (options.folder) logger.info(`Folder filter: ${chalk.cyan(options.folder)}`);
  if (options.target) logger.info(`Target mailbox: ${chalk.cyan(options.target)}`);

  const restore_options: RestoreOptions = {
    ...(options.folder && { folder_name: options.folder }),
    ...(start_date && { start_date }),
    ...(end_date && { end_date }),
    ...(options.target && { target_mailbox: options.target }),
  };

  const result = await service.restore_mailbox(tenant_id, mailbox_id, restore_options);
  report_restore_result(result);
}

/** Prints a human-readable summary of the restore result. */
function report_restore_result(result: RestoreResult): void {
  const att_info =
    result.attachment_count > 0
      ? ` + ${chalk.cyan(String(result.attachment_count))} attachments`
      : '';

  if (result.error_count === 0) {
    logger.success(
      `Restored ${chalk.green(String(result.restored_count))} messages${att_info}` +
        (result.restore_folder_name ? ` into ${chalk.cyan(result.restore_folder_name)}` : ''),
    );
    return;
  }

  logger.warn(
    `Restored ${result.restored_count} messages with ` +
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
