import type { SnapshotSummary } from '@wisecom/atlas-types';

/** Which of an owner's snapshots a prune removes, and which kept ones become baselines. */
export interface SnapshotPrunePlan<S extends SnapshotSummary> {
  /** Snapshots created before the cut-off, newest first. */
  readonly pruned: S[];
  /**
   * The oldest kept snapshots, which fold the pruned ones in. One, unless several share the oldest
   * kept creation time. Empty when nothing is pruned.
   */
  readonly baselines: S[];
  /** Every kept snapshot, newest first. */
  readonly kept: S[];
}

/**
 * Splits an owner's snapshots at the cut-off.
 *
 * A snapshot created strictly before `before` is pruned; one created at exactly `before` is kept,
 * because `delete_snapshot` and the chain loaders count an equal time as newer. The newest snapshot
 * is never pruned, even when it is older than the cut-off: it is what the delta cursor resumes
 * from, and an owner with no snapshot left would restore nothing.
 *
 * Snapshots that share the oldest kept time are all baselines. Each one's chain holds the others,
 * so each folds them in, in the same order its own chain read them.
 */
export function plan_snapshot_prune<S extends SnapshotSummary>(
  summaries: readonly S[],
  before: Date,
): SnapshotPrunePlan<S> {
  const newest_first = [...summaries].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
  const newest = newest_first[0];
  if (newest === undefined) return { pruned: [], baselines: [], kept: [] };

  const cutoff = Math.min(before.getTime(), newest.created_at.getTime());
  const kept = newest_first.filter((s) => s.created_at.getTime() >= cutoff);
  const pruned = newest_first.filter((s) => s.created_at.getTime() < cutoff);
  const oldest_kept = kept[kept.length - 1];
  if (pruned.length === 0 || oldest_kept === undefined) return { pruned, baselines: [], kept };

  const baseline_time = oldest_kept.created_at.getTime();
  const baselines = kept.filter((s) => s.created_at.getTime() === baseline_time);
  return { pruned, baselines, kept };
}

/**
 * The keys a baseline's fold reads, newest first: the baseline, the other snapshots that share its
 * creation time, then every pruned snapshot. This is the chain the baseline's own restore read.
 */
export function baseline_chain_keys<S extends SnapshotSummary>(
  plan: SnapshotPrunePlan<S>,
  baseline: S,
): string[] {
  const siblings = plan.baselines.filter((s) => s.snapshot_id !== baseline.snapshot_id);
  return [baseline, ...siblings, ...plan.pruned].map((s) => s.manifest_key);
}
