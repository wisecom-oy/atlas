import chalk from 'chalk';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type {
  VerificationUseCase,
  VerificationResult,
  StatusUseCase,
  MailboxStatusResult,
  FolderStatus,
  MailboxDiscoveryService,
  TenantMailbox,
} from '@wisecom/atlas-types';
import {
  VERIFICATION_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  MAILBOX_DISCOVERY_TOKEN,
} from '@wisecom/atlas-types';
import { format_bytes, pad_cell, truncate_cell } from '@/command-formatters';
import { logger } from '@wisecom/atlas-core';

export interface OutlookVerifyOptions {
  snapshot: string;
  mailbox: string;
  tenant?: string;
}

export interface OutlookStatusOptions {
  mailbox: string;
  tenant?: string;
}

export interface OutlookMailboxesOptions {
  tenant?: string;
  licensedOnly?: boolean;
}

/** Runs integrity verification and logs the outcome. */
export async function execute_outlook_verify(
  container: Container,
  options: OutlookVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Verify');
  logger.info(`Mailbox: ${chalk.cyan(options.mailbox)}`);
  logger.info(`Verifying snapshot ${chalk.cyan(options.snapshot)}...`);

  const verification_use_case = container.get<VerificationUseCase>(VERIFICATION_USE_CASE_TOKEN);
  const result = await verification_use_case.verify_snapshot_integrity(tenant_id, options.snapshot);
  report_verification_result(result);
}

/** Runs the status check and prints the result. */
export async function execute_outlook_status(
  container: Container,
  options: OutlookStatusOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const status_use_case = container.get<StatusUseCase>(STATUS_USE_CASE_TOKEN);

  logger.banner('Atlas Status');
  logger.info(`Tenant:  ${chalk.cyan(tenant_id)}`);
  logger.info(`Mailbox: ${chalk.cyan(options.mailbox)}`);

  const result = await status_use_case.check_mailbox_status(tenant_id, options.mailbox);
  print_status_result(result);
}

/** Lists tenant mailboxes from Microsoft Graph. */
export async function execute_outlook_mailboxes(
  container: Container,
  options: OutlookMailboxesOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  logger.banner('Atlas Mailboxes');
  logger.info(`Tenant: ${tenant_id}`);

  const discovery = container.get<MailboxDiscoveryService>(MAILBOX_DISCOVERY_TOKEN);
  const discovery_options =
    options.licensedOnly === undefined ? undefined : { licensed_only: options.licensedOnly };
  const mailboxes = await discovery.list_tenant_mailboxes(tenant_id, discovery_options);

  if (mailboxes.length === 0) {
    logger.warn(
      options.licensedOnly
        ? 'No Exchange-licensed mailboxes found in tenant'
        : 'No mailboxes found in tenant',
    );
    return;
  }

  const licensed = mailboxes.filter((m) => m.has_exchange_license).length;
  logger.info(`${mailboxes.length} mailbox(es) found (${licensed} Exchange-licensed)\n`);

  print_mailbox_table(mailboxes);
}

function resolve_tenant_id(container: Container, options: { tenant?: string }): string {
  if (options.tenant) return options.tenant;
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);
  return config.tenant_id;
}

function report_verification_result(result: VerificationResult): void {
  if (result.failed.length === 0) {
    logger.success(
      `All ${chalk.green(String(result.total_checked))} objects passed integrity check`,
    );
    return;
  }

  logger.error(
    `${chalk.red(String(result.failed.length))} of ${result.total_checked} objects failed verification`,
  );
  for (const id of result.failed) {
    logger.error(`  - ${id}`);
  }
  process.exitCode = 1;
}

function print_status_result(result: MailboxStatusResult): void {
  if (result.last_backup_at) {
    const ts = result.last_backup_at.toISOString().replace('T', ' ').slice(0, 16);
    logger.info(`Last backup: ${chalk.white(ts)} (${result.last_snapshot_id ?? 'unknown'})\n`);
  } else {
    logger.warn('No previous backup found for this mailbox.\n');
  }

  const col_folder = 28;
  const col_status = 20;
  const col_pending = 10;
  const header =
    '  ' +
    pad_cell('Folder', col_folder) +
    pad_cell('Status', col_status) +
    pad_cell('Pending', col_pending);
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const f of result.folders) {
    const [status_text, status_color] = format_folder_status(f);
    const [pending_text, pending_color] = format_pending(f);
    console.log(
      '  ' +
        pad_cell(truncate_cell(f.folder_name, col_folder - 2), col_folder) +
        status_color(pad_cell(status_text, col_status)) +
        pending_color(pad_cell(pending_text, col_pending)),
    );
  }

  console.log('  ' + '-'.repeat(header.length - 2));
  console.log();

  if (result.is_up_to_date) {
    logger.success('Mailbox is up to date -- no pending changes.');
  } else {
    const changes = result.total_pending_changes;
    const not_backed_up = result.folders.filter((f) => !f.has_backup).length;
    const parts: string[] = [];
    if (changes > 0) parts.push(`${changes} pending change(s)`);
    if (not_backed_up > 0) parts.push(`${not_backed_up} folder(s) never backed up`);
    logger.info(`Overall: ${parts.join(', ')} across ${result.total_folders} folder(s)`);
  }
}

type ColorFn = (s: string) => string;

function format_folder_status(f: FolderStatus): [string, ColorFn] {
  if (!f.has_backup) return ['never backed up', chalk.yellow];
  if (f.is_up_to_date) return ['up-to-date', chalk.green];
  const total = f.pending_new + f.pending_removed;
  return [`${total} change(s)`, chalk.red];
}

function format_pending(f: FolderStatus): [string, ColorFn] {
  if (!f.has_backup) return ['-', chalk.gray];
  const total = f.pending_new + f.pending_removed;
  return total === 0 ? ['0', chalk.green] : [String(total), chalk.red];
}

function print_mailbox_table(mailboxes: TenantMailbox[]): void {
  const has_sizes = mailboxes.some((m) => m.mailbox_size_bytes !== undefined);
  const header =
    '  ' +
    pad_cell('Mail', 38) +
    pad_cell('Display Name', 24) +
    pad_cell('Exchange', 10) +
    pad_cell('Status', 10) +
    (has_sizes ? pad_cell('Size', 12) : '') +
    'Created';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const m of mailboxes) {
    const license_flag = m.has_exchange_license ? 'Yes' : 'No';
    const status = m.exchange_plan_status ?? '--';
    const created = m.created_at ? m.created_at.toISOString().slice(0, 10) : '--';
    const size = has_sizes ? pad_cell(format_mailbox_size(m.mailbox_size_bytes), 12) : '';
    console.log(
      '  ' +
        pad_cell(truncate_cell(m.mail, 36), 38) +
        pad_cell(truncate_cell(m.display_name, 22), 24) +
        pad_cell(license_flag, 10) +
        pad_cell(status, 10) +
        size +
        created,
    );
  }
}

function format_mailbox_size(bytes?: number): string {
  if (bytes === undefined) return '--';
  return format_bytes(bytes, 2);
}
