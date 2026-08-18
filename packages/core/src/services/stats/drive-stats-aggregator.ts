import type { DriveStats, DriveOwnerSummary, DriveMonthlyBreakdown } from '@wisecom/atlas-types';

/** Common shape of OneDrive and SharePoint snapshot manifests for aggregation. */
export interface DriveManifestSummary {
  readonly owner_id: string;
  readonly owner_label?: string | undefined;
  readonly created_at: Date;
  readonly total_files: number;
  readonly total_size_bytes: number;
}

interface OwnerAccumulator {
  label?: string;
  snapshots: number;
  files: number;
  size: number;
  latest?: Date;
}

interface MonthAccumulator {
  snapshots: number;
  files: number;
  size: number;
}

/** Formats a Date as a "YYYY-MM" string for monthly grouping. */
function to_month_key(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Aggregates drive statistics across all owners/sites in a single pass. */
export function aggregate_drive_stats(
  tenant_id: string,
  service: 'onedrive' | 'sharepoint',
  manifests: readonly DriveManifestSummary[],
): Omit<DriveStats, 'aggregation_us'> {
  const owners = new Map<string, OwnerAccumulator>();
  const months = new Map<string, MonthAccumulator>();
  let total_files = 0;
  let total_size = 0;

  for (const manifest of manifests) {
    total_files += manifest.total_files;
    total_size += manifest.total_size_bytes;

    let owner = owners.get(manifest.owner_id);
    if (!owner) {
      owner = { snapshots: 0, files: 0, size: 0 };
      owners.set(manifest.owner_id, owner);
    }
    owner.snapshots += 1;
    owner.files += manifest.total_files;
    owner.size += manifest.total_size_bytes;
    if (manifest.owner_label) owner.label = manifest.owner_label;
    if (!owner.latest || manifest.created_at > owner.latest) owner.latest = manifest.created_at;

    const month_key = to_month_key(manifest.created_at);
    let month = months.get(month_key);
    if (!month) {
      month = { snapshots: 0, files: 0, size: 0 };
      months.set(month_key, month);
    }
    month.snapshots += 1;
    month.files += manifest.total_files;
    month.size += manifest.total_size_bytes;
  }

  return {
    tenant_id,
    service,
    owner_count: owners.size,
    snapshot_count: manifests.length,
    file_count: total_files,
    total_size_bytes: total_size,
    owners: build_sorted_owners(owners),
    monthly_breakdown: build_sorted_months(months),
  };
}

/** Converts the owner accumulator map into a size-descending DriveOwnerSummary array. */
function build_sorted_owners(owners: Map<string, OwnerAccumulator>): DriveOwnerSummary[] {
  return [...owners.entries()]
    .map(([owner_id, acc]) => ({
      owner_id,
      snapshot_count: acc.snapshots,
      file_count: acc.files,
      total_size_bytes: acc.size,
      ...(acc.label !== undefined && { owner_label: acc.label }),
      ...(acc.latest !== undefined && { latest_backup_at: acc.latest.toISOString() }),
    }))
    .sort((a, b) => b.total_size_bytes - a.total_size_bytes);
}

/** Converts the month accumulator map into a chronologically sorted array. */
function build_sorted_months(months: Map<string, MonthAccumulator>): DriveMonthlyBreakdown[] {
  return [...months.entries()]
    .map(([month, acc]) => ({
      month,
      snapshot_count: acc.snapshots,
      file_count: acc.files,
      total_size_bytes: acc.size,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}
