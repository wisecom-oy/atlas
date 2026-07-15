import type { DriveStats, DriveOwnerSummary, DriveMonthlyBreakdown } from '@wisecom/atlas-types';
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { DataTable } from '@/ui/components/data-table';
import type { TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';
import { format_bytes, format_microseconds } from '@/command-formatters';

const SERVICE_LABELS: Record<DriveStats['service'], { title: string; owners: string }> = {
  onedrive: { title: 'Atlas OneDrive Statistics', owners: 'Owners' },
  sharepoint: { title: 'Atlas SharePoint Statistics', owners: 'Sites' },
};

/** Renders OneDrive or SharePoint drive statistics as banner, overview, and tables. */
export async function print_drive_stats(stats: DriveStats, top: number): Promise<void> {
  const labels = SERVICE_LABELS[stats.service];
  await render_static_view(
    <Box flexDirection="column">
      <Banner title={labels.title} subtitle={`Tenant: ${stats.tenant_id}`} />
      <Text bold>Overview</Text>
      <KeyValueList items={build_overview_items(stats, labels.owners)} />
      {stats.owners.length > 0 ? (
        <OwnerTable owners={stats.owners.slice(0, top)} heading={labels.owners} />
      ) : undefined}
      {stats.monthly_breakdown.length > 0 ? (
        <DriveMonthlyTable months={stats.monthly_breakdown} />
      ) : undefined}
    </Box>,
  );
}

/** Builds the Overview key/value items for drive statistics. */
function build_overview_items(stats: DriveStats, owner_heading: string): KeyValueItem[] {
  return [
    { label: owner_heading, value: String(stats.owner_count) },
    { label: 'Snapshots', value: String(stats.snapshot_count) },
    { label: 'Files', value: String(stats.file_count) },
    { label: 'Total size', value: format_bytes(stats.total_size_bytes) },
    { label: 'Aggregation time', value: format_microseconds(stats.aggregation_us) },
  ];
}

interface OwnerRow {
  name: string;
  snapshots: number;
  files: number;
  size: string;
  latest: string;
}

const OWNER_COLUMNS: TableColumn<OwnerRow>[] = [
  { key: 'name', header: 'Name', max_width: 40 },
  { key: 'snapshots', header: 'Snapshots' },
  { key: 'files', header: 'Files' },
  { key: 'size', header: 'Size' },
  { key: 'latest', header: 'Last backup' },
];

function OwnerTable({
  owners,
  heading,
}: {
  owners: DriveOwnerSummary[];
  heading: string;
}): ReactElement {
  const rows: OwnerRow[] = owners.map((o) => ({
    name: o.owner_label ?? o.owner_id,
    snapshots: o.snapshot_count,
    files: o.file_count,
    size: format_bytes(o.total_size_bytes),
    latest: o.latest_backup_at ?? '-',
  }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{heading}</Text>
      <DataTable columns={OWNER_COLUMNS} rows={rows} />
    </Box>
  );
}

interface DriveMonthRow {
  month: string;
  snapshots: number;
  files: number;
  size: string;
}

const DRIVE_MONTH_COLUMNS: TableColumn<DriveMonthRow>[] = [
  { key: 'month', header: 'Month' },
  { key: 'snapshots', header: 'Snapshots' },
  { key: 'files', header: 'Files' },
  { key: 'size', header: 'Size' },
];

function DriveMonthlyTable({ months }: { months: DriveMonthlyBreakdown[] }): ReactElement {
  const rows: DriveMonthRow[] = months.map((m) => ({
    month: m.month,
    snapshots: m.snapshot_count,
    files: m.file_count,
    size: format_bytes(m.total_size_bytes),
  }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Monthly Breakdown</Text>
      <DataTable columns={DRIVE_MONTH_COLUMNS} rows={rows} />
    </Box>
  );
}
