import type {
  BucketStats,
  MailboxStats,
  OutlookSnapshotAggregates,
  OutlookSnapshotSummary,
  SnapshotFolderTotals,
} from '@wisecom/atlas-types';
import {
  build_sorted_breakdown,
  build_sorted_folders,
  to_month_key,
} from '@/services/stats/stats-aggregator';

interface Totals {
  messages: number;
  size: number;
  att_count: number;
  att_size: number;
}

interface MonthTotals extends Totals {
  snapshots: number;
}

/**
 * Returns a snapshot row's per-snapshot figures. The reader decrypts every row without them before
 * aggregating, so a missing one is a broken invariant and raises instead of counting zero.
 */
export function aggregates_of(summary: OutlookSnapshotSummary): OutlookSnapshotAggregates {
  if (summary.aggregates === undefined) {
    throw new Error(`Snapshot ${summary.snapshot_id} has no aggregates in its summary row`);
  }
  return summary.aggregates;
}

/** Sums the message bytes (entries plus attachments) of every snapshot's own manifest. */
export function sum_entry_bytes(summaries: readonly OutlookSnapshotSummary[]): number {
  return summaries.reduce((sum, summary) => sum + aggregates_of(summary).entry_size_bytes, 0);
}

/**
 * Bucket-wide statistics from every snapshot's summary row, equal to `aggregate_bucket_stats` over
 * the same manifests (#726).
 */
export function aggregate_bucket_stats_from_summaries(
  tenant_id: string,
  summaries: readonly OutlookSnapshotSummary[],
): BucketStats {
  const owner_ids = new Set<string>();
  const totals = empty_totals();
  const monthly = new Map<string, MonthTotals>();
  for (const summary of summaries) {
    owner_ids.add(summary.owner_id);
    add_snapshot(totals, monthly, summary);
  }
  return {
    tenant_id,
    mailbox_count: owner_ids.size,
    snapshot_count: summaries.length,
    total_messages: totals.messages,
    total_size_bytes: totals.size,
    attachment_count: totals.att_count,
    attachment_size_bytes: totals.att_size,
    monthly_breakdown: build_sorted_breakdown(monthly),
    aggregation_us: 0,
  };
}

/**
 * One mailbox's statistics from its summary rows, equal to `aggregate_mailbox_stats` over the same
 * manifests (#726).
 */
export function aggregate_mailbox_stats_from_summaries(
  owner_id: string,
  summaries: readonly OutlookSnapshotSummary[],
): MailboxStats {
  const totals = empty_totals();
  const monthly = new Map<string, MonthTotals>();
  const folders = new Map<string, Totals>();
  for (const summary of summaries) {
    add_snapshot(totals, monthly, summary);
    for (const folder of aggregates_of(summary).folders) add_folder(folders, folder);
  }
  return {
    owner_id,
    snapshot_count: summaries.length,
    total_messages: totals.messages,
    total_size_bytes: totals.size,
    attachment_count: totals.att_count,
    attachment_size_bytes: totals.att_size,
    folders: build_sorted_folders(folders),
    monthly_breakdown: build_sorted_breakdown(monthly),
    aggregation_us: 0,
  };
}

/** Adds one snapshot's row to the running totals and to its calendar month. */
function add_snapshot(
  totals: Totals,
  monthly: Map<string, MonthTotals>,
  summary: OutlookSnapshotSummary,
): void {
  const aggregates = aggregates_of(summary);
  const counts: Totals = {
    messages: summary.entry_count,
    size: aggregates.entry_size_bytes,
    att_count: aggregates.attachment_count,
    att_size: aggregates.attachment_size_bytes,
  };
  add_counts(totals, counts);
  const key = to_month_key(summary.created_at);
  const month = monthly.get(key) ?? { snapshots: 0, ...empty_totals() };
  month.snapshots += 1;
  add_counts(month, counts);
  monthly.set(key, month);
}

/** Adds one snapshot's per-folder totals to the folder map. */
function add_folder(folders: Map<string, Totals>, folder: SnapshotFolderTotals): void {
  const totals = folders.get(folder.folder_id) ?? empty_totals();
  add_counts(totals, {
    messages: folder.message_count,
    size: folder.total_size_bytes,
    att_count: folder.attachment_count,
    att_size: folder.attachment_size_bytes,
  });
  folders.set(folder.folder_id, totals);
}

function add_counts(target: Totals, delta: Totals): void {
  target.messages += delta.messages;
  target.size += delta.size;
  target.att_count += delta.att_count;
  target.att_size += delta.att_size;
}

function empty_totals(): Totals {
  return { messages: 0, size: 0, att_count: 0, att_size: 0 };
}
