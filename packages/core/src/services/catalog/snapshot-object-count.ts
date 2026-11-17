import {
  HASHED_OBJECT_ID_LENGTH,
  type Manifest,
  type OutlookSnapshotAggregates,
  type OutlookSnapshotSummary,
} from '@wisecom/atlas-types';
import { join_hashed_ids } from '@/services/catalog/outlook-snapshot-aggregates';
import { aggregates_of } from '@/services/stats/stats-summary-aggregator';

/** The hashed IDs one snapshot adds and removes: all a merged count needs from it. */
type SnapshotIdSets = Pick<OutlookSnapshotAggregates, 'object_ids' | 'removed_ids'>;

/**
 * Counts the live objects of one mailbox's snapshots, given newest first: the number of entries
 * `merge_snapshot_entries` returns for the same manifests. The IDs are hashed, so a collision would
 * under-count, which the 96-bit hash makes negligible.
 */
export function count_merged_objects(newest_first: readonly OutlookSnapshotSummary[]): number {
  return count_live_ids(newest_first.map(aggregates_of));
}

/**
 * Counts the objects each snapshot's chain holds, keyed by snapshot ID: the snapshot plus every
 * older one, the set `verify`, `restore -s` and `save -s` read (issue #711). One pass from the
 * oldest row, so the cost grows with the IDs recorded, not with snapshots times IDs.
 */
export function count_objects_by_snapshot(
  summaries: readonly OutlookSnapshotSummary[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const live = new Set<string>();
  for (const summary of oldest_first(summaries)) {
    apply_snapshot(live, aggregates_of(summary));
    counts.set(summary.snapshot_id, live.size);
  }
  return counts;
}

/**
 * Counts the objects a mailbox holds after a backup run: the chain of the existing rows, given
 * newest first, topped by the run's manifest when the run wrote one. Undefined `written` means a
 * quiet run, whose result reports the head snapshot left in place.
 */
export function count_objects_after_run(
  newest_first: readonly OutlookSnapshotSummary[],
  written: Manifest | undefined,
): number {
  const chain: SnapshotIdSets[] = newest_first.map(aggregates_of);
  if (written) chain.unshift(id_sets_of(written));
  return count_live_ids(chain);
}

/** Counts the IDs alive at the newest of these snapshots, given newest first. */
function count_live_ids(newest_first: readonly SnapshotIdSets[]): number {
  const live = new Set<string>();
  for (let i = newest_first.length - 1; i >= 0; i -= 1) apply_snapshot(live, newest_first[i]!);
  return live.size;
}

/**
 * Moves the live set forward by one newer snapshot. Its removals go first, so a message it both
 * removed and recorded, a move between folders, stays live, as it does in `merge_snapshot_entries`.
 */
function apply_snapshot(live: Set<string>, snapshot: SnapshotIdSets): void {
  for (const id of split_hashed_ids(snapshot.removed_ids)) live.delete(id);
  for (const id of split_hashed_ids(snapshot.object_ids)) live.add(id);
}

/** The hashed ID sets a manifest's summary row will carry. */
function id_sets_of(manifest: Manifest): SnapshotIdSets {
  return {
    object_ids: join_hashed_ids(manifest.entries.map((entry) => entry.object_id)),
    removed_ids: join_hashed_ids(manifest.removed_object_ids ?? []),
  };
}

/** Orders rows by creation time, oldest first: `load_snapshot_chain` walks them in reverse. */
function oldest_first(summaries: readonly OutlookSnapshotSummary[]): OutlookSnapshotSummary[] {
  return [...summaries].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

/** Splits a row's concatenated hashed IDs into one string per ID. */
function split_hashed_ids(joined: string): string[] {
  const ids: string[] = [];
  for (let start = 0; start < joined.length; start += HASHED_OBJECT_ID_LENGTH) {
    ids.push(joined.slice(start, start + HASHED_OBJECT_ID_LENGTH));
  }
  return ids;
}
