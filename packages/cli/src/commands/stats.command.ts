import type { Command } from 'commander';
import type { Container } from 'inversify';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import type { StatsUseCase } from '@wisecom/atlas-types';
import { STATS_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import type {
  BucketStats,
  MailboxStats,
  FolderStats,
  MonthlyBreakdown,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { format_bytes, format_microseconds, pad_cell, truncate_cell } from '@/command-formatters';

type ContainerFactory = () => Container;

interface StatsOptions {
  tenant?: string;
  mailbox?: string;
  json?: boolean;
}

/** Registers the `atlas stats` subcommand for storage statistics. */
export function register_stats_command(program: Command, get_container: ContainerFactory): void {
  program
    .command('stats')
    .description('Show storage statistics for the bucket or a specific mailbox')
    .option('-t, --tenant <id>', 'tenant identifier (defaults to config)')
    .option('-m, --mailbox <email>', 'show statistics for a specific mailbox')
    .option('--json', 'output raw JSON instead of formatted table')
    .action((options: StatsOptions) => execute_stats(get_container(), options));
}

/** Routes to bucket-level or mailbox-level stats based on flags. */
async function execute_stats(container: Container, options: StatsOptions): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);

  if (options.mailbox) {
    const result = await stats.get_mailbox_stats(tenant_id, options.mailbox);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      print_mailbox_stats(result);
    }
  } else {
    const result = await stats.get_bucket_stats(tenant_id);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      print_bucket_stats(result);
    }
  }
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: StatsOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

function print_bucket_stats(stats: BucketStats): void {
  logger.banner('Atlas Bucket Statistics');
  logger.info(`Tenant: ${stats.tenant_id}\n`);

  console.log('  Overview');
  console.log('  ' + '-'.repeat(44));
  console.log(`  Mailboxes:          ${stats.mailbox_count}`);
  console.log(`  Snapshots:          ${stats.snapshot_count}`);
  console.log(`  Messages:           ${stats.total_messages}`);
  console.log(`  Total size:         ${format_bytes(stats.total_size_bytes)}`);
  console.log(`  Attachments:        ${stats.attachment_count}`);
  console.log(`  Attachment size:    ${format_bytes(stats.attachment_size_bytes)}`);
  console.log(`  Aggregation time:   ${format_microseconds(stats.aggregation_us)}`);

  if (stats.monthly_breakdown.length > 0) {
    print_monthly_breakdown(stats.monthly_breakdown);
  }
}

function print_mailbox_stats(stats: MailboxStats): void {
  logger.banner('Atlas Mailbox Statistics');
  logger.info(`Mailbox: ${stats.owner_id}\n`);

  console.log('  Overview');
  console.log('  ' + '-'.repeat(44));
  console.log(`  Snapshots:          ${stats.snapshot_count}`);
  console.log(`  Messages:           ${stats.total_messages}`);
  console.log(`  Total size:         ${format_bytes(stats.total_size_bytes)}`);
  console.log(`  Attachments:        ${stats.attachment_count}`);
  console.log(`  Attachment size:    ${format_bytes(stats.attachment_size_bytes)}`);
  console.log(`  Aggregation time:   ${format_microseconds(stats.aggregation_us)}`);

  if (stats.folders.length > 0) {
    print_folder_table(stats.folders);
  }

  if (stats.monthly_breakdown.length > 0) {
    print_monthly_breakdown(stats.monthly_breakdown);
  }
}

function print_folder_table(folders: FolderStats[]): void {
  console.log('\n  Folders');
  const header =
    '  ' +
    pad_cell('Folder', 36) +
    pad_cell('Messages', 12) +
    pad_cell('Size', 12) +
    pad_cell('Att', 8) +
    'Att size';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const f of folders) {
    console.log(
      '  ' +
        pad_cell(truncate_cell(f.folder_id, 34), 36) +
        pad_cell(String(f.message_count), 12) +
        pad_cell(format_bytes(f.total_size_bytes), 12) +
        pad_cell(String(f.attachment_count), 8) +
        format_bytes(f.attachment_size_bytes),
    );
  }
}

function print_monthly_breakdown(months: MonthlyBreakdown[]): void {
  console.log('\n  Monthly Breakdown');
  const header =
    '  ' +
    pad_cell('Month', 12) +
    pad_cell('Snapshots', 12) +
    pad_cell('Messages', 12) +
    pad_cell('Size', 12) +
    pad_cell('Att', 8) +
    'Att size';
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));

  for (const m of months) {
    console.log(
      '  ' +
        pad_cell(m.month, 12) +
        pad_cell(String(m.snapshot_count), 12) +
        pad_cell(String(m.message_count), 12) +
        pad_cell(format_bytes(m.size_bytes), 12) +
        pad_cell(String(m.attachment_count), 8) +
        format_bytes(m.attachment_size_bytes),
    );
  }
}
