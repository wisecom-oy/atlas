import type { Manifest, OutlookSnapshotSummary } from '@wisecom/atlas-types';
import { count_objects_after_run } from '@wisecom/atlas-core/services/catalog/snapshot-object-count';
import { run_writes_snapshot } from '@/services/backup/mailbox-run-persister';

/**
 * Counts the messages of the snapshot a run reports, the merged chain `verify`, `restore -s` and
 * `save -s` read (issue #711): the run's own manifest over the rows of every earlier snapshot when
 * the run writes one, and the head's chain when it is quiet. `chain_rows` are the mailbox's summary
 * rows read before the run, newest first.
 *
 * The manifest's `total_objects` stays the high-water mark the stale-delta safeguard reads.
 */
export function count_run_objects(
  chain_rows: readonly OutlookSnapshotSummary[],
  manifest: Manifest,
  previous: Manifest | undefined,
): number {
  const written = run_writes_snapshot(manifest, previous) ? manifest : undefined;
  return count_objects_after_run(chain_rows, written);
}

/** Joins the damaged manifest keys two reads reported, each key once. */
export function distinct_unreadable_keys(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}
