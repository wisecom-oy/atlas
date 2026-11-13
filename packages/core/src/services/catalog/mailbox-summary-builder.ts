import {
  HASHED_OBJECT_ID_LENGTH,
  type MailboxSummary,
  type OutlookSnapshotSummary,
} from '@wisecom/atlas-types';
import { aggregates_of } from '@/services/stats/stats-summary-aggregator';

/**
 * Builds one MailboxSummary per owner from the owners' summary rows (#726). The object count is the
 * merged chain of the mailbox's snapshots, so messages a later run recorded as removed are not
 * counted (#536). total_size_bytes sums every snapshot, since each incremental snapshot only stores
 * newly arrived data. The purpose and address come from the newest row that recorded one.
 */
export function build_mailbox_summaries(
  summaries: readonly OutlookSnapshotSummary[],
): MailboxSummary[] {
  const by_owner = group_by_owner(summaries);
  return [...by_owner]
    .map(([owner_id, rows]) => mailbox_summary(owner_id, rows))
    .sort((a, b) => a.owner_id.localeCompare(b.owner_id));
}

/**
 * Counts the live objects of one mailbox's snapshots, given newest first. Mirrors
 * `merge_snapshot_entries`: an object counts once, at its newest appearance, and a removal hides
 * the same ID in every older snapshot. The IDs are hashed, so a collision would under-count, which
 * the 96-bit hash makes negligible.
 */
export function count_merged_objects(newest_first: readonly OutlookSnapshotSummary[]): number {
  const seen = new Set<string>();
  let count = 0;
  for (const summary of newest_first) {
    const aggregates = aggregates_of(summary);
    for (const id of split_hashed_ids(aggregates.object_ids)) {
      if (seen.has(id)) continue;
      seen.add(id);
      count += 1;
    }
    for (const id of split_hashed_ids(aggregates.removed_ids)) seen.add(id);
  }
  return count;
}

function mailbox_summary(
  owner_id: string,
  rows: readonly OutlookSnapshotSummary[],
): MailboxSummary {
  const newest_first = [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  const latest = newest_first[0]!;
  const purpose = newest_first.find((row) => row.mailbox_purpose)?.mailbox_purpose;
  const owner_email = newest_first.find((row) => row.owner_email)?.owner_email;
  return {
    owner_id,
    ...(owner_email ? { owner_email } : {}),
    ...(purpose ? { mailbox_purpose: purpose } : {}),
    snapshot_count: newest_first.length,
    total_objects: count_merged_objects(newest_first),
    total_size_bytes: newest_first.reduce((sum, row) => sum + row.total_size_bytes, 0),
    last_backup_at: latest.created_at,
  };
}

function group_by_owner(
  summaries: readonly OutlookSnapshotSummary[],
): Map<string, OutlookSnapshotSummary[]> {
  const by_owner = new Map<string, OutlookSnapshotSummary[]>();
  for (const summary of summaries) {
    const rows = by_owner.get(summary.owner_id) ?? [];
    rows.push(summary);
    by_owner.set(summary.owner_id, rows);
  }
  return by_owner;
}

/** Splits a row's concatenated hashed IDs into one string per ID. */
function split_hashed_ids(joined: string): string[] {
  const ids: string[] = [];
  for (let start = 0; start < joined.length; start += HASHED_OBJECT_ID_LENGTH) {
    ids.push(joined.slice(start, start + HASHED_OBJECT_ID_LENGTH));
  }
  return ids;
}
