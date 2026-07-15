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
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { DataTable } from '@/ui/components/data-table';
import type { TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';
import { format_bytes, format_microseconds } from '@/command-formatters';

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
      await print_mailbox_stats(result);
    }
  } else {
    const result = await stats.get_bucket_stats(tenant_id);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      await print_bucket_stats(result);
    }
  }
}

/** Resolves the tenant ID from CLI flag or config. */
function resolve_tenant_id(container: Container, options: StatsOptions): string {
  if (options.tenant) return options.tenant;
  return container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN).tenant_id;
}

async function print_bucket_stats(stats: BucketStats): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Bucket Statistics" subtitle={`Tenant: ${stats.tenant_id}`} />
      <Text bold>Overview</Text>
      <KeyValueList items={build_overview_items(stats)} />
      {stats.monthly_breakdown.length > 0 ? (
        <MonthlyBreakdownTable months={stats.monthly_breakdown} />
      ) : undefined}
    </Box>,
  );
}

async function print_mailbox_stats(stats: MailboxStats): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Atlas Mailbox Statistics" subtitle={`Mailbox: ${stats.owner_id}`} />
      <Text bold>Overview</Text>
      <KeyValueList items={build_overview_items(stats)} />
      {stats.folders.length > 0 ? <FolderTable folders={stats.folders} /> : undefined}
      {stats.monthly_breakdown.length > 0 ? (
        <MonthlyBreakdownTable months={stats.monthly_breakdown} />
      ) : undefined}
    </Box>,
  );
}

/** Builds the shared Overview key/value items; bucket stats add the mailbox count. */
function build_overview_items(stats: BucketStats | MailboxStats): KeyValueItem[] {
  const items: KeyValueItem[] = [];
  if ('mailbox_count' in stats) {
    items.push({ label: 'Mailboxes', value: String(stats.mailbox_count) });
  }
  items.push(
    { label: 'Snapshots', value: String(stats.snapshot_count) },
    { label: 'Messages', value: String(stats.total_messages) },
    { label: 'Total size', value: format_bytes(stats.total_size_bytes) },
    { label: 'Attachments', value: String(stats.attachment_count) },
    { label: 'Attachment size', value: format_bytes(stats.attachment_size_bytes) },
    { label: 'Aggregation time', value: format_microseconds(stats.aggregation_us) },
  );
  return items;
}

interface FolderRow {
  folder: string;
  messages: number;
  size: string;
  attachments: number;
  attachment_size: string;
}

const FOLDER_COLUMNS: TableColumn<FolderRow>[] = [
  { key: 'folder', header: 'Folder', max_width: 36 },
  { key: 'messages', header: 'Messages' },
  { key: 'size', header: 'Size' },
  { key: 'attachments', header: 'Att' },
  { key: 'attachment_size', header: 'Att size' },
];

function FolderTable({ folders }: { folders: FolderStats[] }): ReactElement {
  const rows: FolderRow[] = folders.map((f) => ({
    folder: f.folder_id,
    messages: f.message_count,
    size: format_bytes(f.total_size_bytes),
    attachments: f.attachment_count,
    attachment_size: format_bytes(f.attachment_size_bytes),
  }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Folders</Text>
      <DataTable columns={FOLDER_COLUMNS} rows={rows} />
    </Box>
  );
}

interface MonthRow {
  month: string;
  snapshots: number;
  messages: number;
  size: string;
  attachments: number;
  attachment_size: string;
}

const MONTH_COLUMNS: TableColumn<MonthRow>[] = [
  { key: 'month', header: 'Month' },
  { key: 'snapshots', header: 'Snapshots' },
  { key: 'messages', header: 'Messages' },
  { key: 'size', header: 'Size' },
  { key: 'attachments', header: 'Att' },
  { key: 'attachment_size', header: 'Att size' },
];

function MonthlyBreakdownTable({ months }: { months: MonthlyBreakdown[] }): ReactElement {
  const rows: MonthRow[] = months.map((m) => ({
    month: m.month,
    snapshots: m.snapshot_count,
    messages: m.message_count,
    size: format_bytes(m.size_bytes),
    attachments: m.attachment_count,
    attachment_size: format_bytes(m.attachment_size_bytes),
  }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Monthly Breakdown</Text>
      <DataTable columns={MONTH_COLUMNS} rows={rows} />
    </Box>
  );
}
