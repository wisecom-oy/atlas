import type { StorageUsage, StorageUsageTotals } from '@wisecom/atlas-types';
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { Banner } from '@/ui/components/banner';
import { KeyValueList } from '@/ui/components/key-value-list';
import type { KeyValueItem } from '@/ui/components/key-value-list';
import { DataTable } from '@/ui/components/data-table';
import type { TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';
import { format_bytes } from '@/command-formatters';

interface NamedTotals {
  readonly name: string;
  readonly totals: StorageUsageTotals;
}

/** Renders a storage usage report: overview, per-workload table, and owners when requested. */
export async function print_storage_usage(usage: StorageUsage, top: number): Promise<void> {
  const workloads: NamedTotals[] = Object.entries(usage.by_workload).flatMap(([name, totals]) =>
    totals ? [{ name, totals }] : [],
  );
  const owners: NamedTotals[] = (usage.by_owner ?? []).slice(0, top).map((owner) => ({
    name: `${owner.workload}/${owner.owner_id || '-'}`,
    totals: owner.totals,
  }));
  const visible = { versions: usage.versions_visible, uploads: usage.incomplete_uploads_visible };
  await render_static_view(
    <Box flexDirection="column">
      <Banner title="Storage Usage" subtitle={`Target: ${usage.target}`} />
      <Text bold>Overview</Text>
      <KeyValueList items={build_overview_items(usage)} />
      <UsageTable heading="By workload" rows={workloads} visible={visible} />
      {owners.length > 0 ? (
        <UsageTable heading="By owner" rows={owners} visible={visible} />
      ) : undefined}
      {usage.complete ? undefined : <ResumeHint token={usage.continuation_token ?? ''} />}
    </Box>,
  );
}

const NOT_VISIBLE = 'not visible to these credentials';

function build_overview_items(usage: StorageUsage): KeyValueItem[] {
  const { totals } = usage;
  const partial = !usage.versions_visible || !usage.incomplete_uploads_visible;
  const items: KeyValueItem[] = [
    { label: 'Stored', value: (partial ? 'at least ' : '') + format_bytes(usage.stored_bytes) },
    { label: 'Current', value: tally(totals.current) },
    { label: 'Noncurrent', value: usage.versions_visible ? tally(totals.noncurrent) : NOT_VISIBLE },
    {
      label: 'Delete markers',
      value: usage.versions_visible ? String(totals.delete_markers) : NOT_VISIBLE,
    },
    { label: 'Staging', value: tally(totals.staging) },
    {
      label: 'Incomplete uploads',
      value: usage.incomplete_uploads_visible ? tally(totals.incomplete_uploads) : NOT_VISIBLE,
    },
  ];
  if (usage.logical_bytes_referenced !== undefined) {
    items.push({
      label: 'Logical referenced',
      value: format_bytes(usage.logical_bytes_referenced),
    });
    // A ratio over a partial stored figure would overstate what deduplication saves.
    if (usage.stored_bytes > 0 && !partial) {
      const ratio = usage.logical_bytes_referenced / usage.stored_bytes;
      items.push({ label: 'Logical / stored', value: `${ratio.toFixed(2)}x` });
    }
  }
  items.push(
    { label: 'List requests', value: String(usage.list_requests) },
    { label: 'Complete', value: usage.complete ? 'yes' : 'no' },
  );
  return items;
}

function tally({ objects, bytes }: { objects: number; bytes: number }): string {
  return `${format_bytes(bytes)} in ${objects} objects`;
}

interface UsageRow {
  name: string;
  current: string;
  noncurrent: string;
  markers: string;
  staging: string;
  uploads: string;
  stored: string;
}

const USAGE_COLUMNS: TableColumn<UsageRow>[] = [
  { key: 'name', header: 'Name', max_width: 48 },
  { key: 'current', header: 'Current', align: 'right' },
  { key: 'noncurrent', header: 'Noncurrent', align: 'right' },
  { key: 'markers', header: 'Markers', align: 'right' },
  { key: 'staging', header: 'Staging', align: 'right' },
  { key: 'uploads', header: 'Uploads', align: 'right' },
  { key: 'stored', header: 'Stored', align: 'right' },
];

/** What the credentials could list. A refused category reads `n/a`, never `0 B`. */
interface Visibility {
  readonly versions: boolean;
  readonly uploads: boolean;
}

function UsageTable({
  heading,
  rows,
  visible,
}: {
  heading: string;
  rows: NamedTotals[];
  visible: Visibility;
}): ReactElement {
  const partial = !visible.versions || !visible.uploads;
  const table_rows: UsageRow[] = rows.map(({ name, totals }) => ({
    name,
    current: format_bytes(totals.current.bytes),
    noncurrent: visible.versions ? format_bytes(totals.noncurrent.bytes) : 'n/a',
    markers: visible.versions ? String(totals.delete_markers) : 'n/a',
    staging: format_bytes(totals.staging.bytes),
    uploads: visible.uploads ? format_bytes(totals.incomplete_uploads.bytes) : 'n/a',
    stored:
      (partial ? '>= ' : '') +
      format_bytes(
        totals.current.bytes + totals.noncurrent.bytes + totals.incomplete_uploads.bytes,
      ),
  }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{heading}</Text>
      <DataTable columns={USAGE_COLUMNS} rows={table_rows} />
    </Box>
  );
}

function ResumeHint({ token }: { token: string }): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">Stopped early. Resume with the same flags plus:</Text>
      <Text>--continue {token}</Text>
    </Box>
  );
}
