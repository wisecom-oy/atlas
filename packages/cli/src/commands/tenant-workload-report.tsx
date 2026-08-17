import { Box } from 'ink';
import type { ReplicationResult, TenantReplicationResult } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { KeyValueList } from '@/ui/components/key-value-list';
import { ResultSummary } from '@/ui/components/result-summary';
import { DataTable } from '@/ui/components/data-table';
import type { TableColumn } from '@/ui/components/data-table';
import { render_static_view } from '@/ui/render';
import { format_bytes } from '@/command-formatters';

/** Renders one replication or recovery result, and fails the process when objects failed. */
export async function report_replication_result(result: ReplicationResult): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
      <KeyValueList
        items={[
          {
            label: 'Result',
            value: result.status,
            color: result.status === 'COMPLETED' ? 'green' : 'red',
          },
        ]}
      />
      <ResultSummary
        entries={[
          { label: 'copied', value: result.objects_copied, color: 'green' },
          { label: 'skipped', value: result.objects_skipped, color: 'yellow' },
          { label: 'failed', value: result.objects_failed, color: 'red' },
        ]}
        suffix={`${format_bytes(result.bytes_copied)}, ${result.elapsed_ms}ms`}
      />
    </Box>,
  );

  for (const err of result.errors) {
    logger.error(`  ${err}`);
  }

  if (result.objects_failed > 0) process.exitCode = 1;
}

interface WorkloadRow {
  workload: string;
  scope: string;
  copied: number;
  skipped: number;
  failed: number;
  size: string;
}

const WORKLOAD_COLUMNS: TableColumn<WorkloadRow>[] = [
  { key: 'workload', header: 'Workload', color: () => 'cyan' },
  { key: 'scope', header: 'Scope' },
  { key: 'copied', header: 'Copied' },
  { key: 'skipped', header: 'Skipped' },
  { key: 'failed', header: 'Failed', color: (row) => (row.failed > 0 ? 'red' : undefined) },
  { key: 'size', header: 'Size' },
];

/**
 * Reports a tenant-wide run: one row per workload, so covering only part of the tenant is visible.
 *
 * `empty_workload_source` enables the "nothing found" warning and names where nothing was found.
 * Only recovery passes it: recovery counts a skip per manifest already on primary, so zero copied
 * AND zero skipped really means the replica held nothing. Replication diffs snapshots out against
 * the target before producing any result, so an up-to-date target legitimately reports zeroes --
 * warning there would fire on every scheduled run and train operators to ignore it.
 */
export async function report_tenant_workloads(
  result: TenantReplicationResult,
  empty_workload_source?: string,
): Promise<void> {
  const rows: WorkloadRow[] = result.workloads.map((w) => ({
    workload: w.workload,
    scope: w.result.snapshot_id,
    copied: w.result.objects_copied,
    skipped: w.result.objects_skipped,
    failed: w.result.objects_failed,
    size: format_bytes(w.result.bytes_copied),
  }));

  await render_static_view(<DataTable columns={WORKLOAD_COLUMNS} rows={rows} />);
  await report_replication_result(result.total);

  if (empty_workload_source === undefined) return;

  const empty = result.workloads.filter(
    (w) => w.result.objects_copied === 0 && w.result.objects_skipped === 0,
  );
  if (empty.length > 0) {
    logger.warn(
      `No snapshots found on the ${empty_workload_source} for: ` +
        `${empty.map((w) => w.workload).join(', ')}. ` +
        'Confirm this matches the source before treating the recovery as complete.',
    );
  }
}
