import type { Command } from 'commander';
import chalk from 'chalk';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import type {
  StatusUseCase,
  MailboxStatusResult,
  FolderStatus,
} from '@/ports/status/use-case.port';
import { STATUS_USE_CASE_TOKEN } from '@/ports/tokens/use-case.tokens';
import { logger } from '@/utils/logger';
import { pad_cell, truncate_cell } from '@/cli/command-formatters';

type ContainerFactory = () => Container;

interface StatusOptions {
  mailbox: string;
  tenant?: string;
}

/** Registers the `atlas status` subcommand. */
export function register_status_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('status')
    .description('Check if a mailbox backup is up to date (delta peek, no backup runs)')
    .requiredOption('-m, --mailbox <email>', 'mailbox to check')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .action((options: StatusOptions) => execute_status(get_container(), options));
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: StatusOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

/** Runs the status check and prints the result. */
async function execute_status(container: Container, options: StatusOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const status_use_case = container.get<StatusUseCase>(STATUS_USE_CASE_TOKEN);

  logger.banner('Atlas Status');
  logger.info(`Tenant:  ${chalk.cyan(tenant_id)}`);
  logger.info(`Mailbox: ${chalk.cyan(options.mailbox)}`);

  const result = await status_use_case.check_mailbox_status(tenant_id, options.mailbox);
  print_status_result(result);
}

/** Prints the backup freshness report as a table. */
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
