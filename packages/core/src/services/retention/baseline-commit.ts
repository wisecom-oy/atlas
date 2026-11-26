import type { HeldOwnerLease, SnapshotSummary } from '@wisecom/atlas-types';
import { UnreadableContentError, UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  baseline_chain_keys,
  type SnapshotPrunePlan,
} from '@/services/retention/snapshot-prune-plan';
import type {
  PrunableManifest,
  SnapshotPruneTarget,
} from '@/services/retention/snapshot-prune-target';

/** A baseline folded in memory, and whether storage already holds exactly it. */
export interface FoldedBaseline<M> {
  readonly baseline: M;
  readonly already_stored: boolean;
}

/**
 * Folds the chain of every baseline the plan names. Each chain is read one manifest at a time,
 * the baseline first and then older ones, so memory holds the growing baseline and one manifest.
 *
 * Every link must read: a missing or damaged one may hold the newest state of an item, or the
 * removal that hides it, and folding without it would change what the kept snapshot restores. The
 * prune is refused with each such key named, before anything is written.
 */
export async function fold_baselines<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  plan: SnapshotPrunePlan<SnapshotSummary>,
): Promise<FoldedBaseline<M>[]> {
  const folded: FoldedBaseline<M>[] = [];
  for (const baseline of plan.baselines) {
    folded.push(await fold_baseline(target, baseline_chain_keys(plan, baseline)));
  }
  return folded;
}

/**
 * Writes each baseline storage does not already hold. A repeated run folds the same chain into the
 * same baseline, finds it stored, and writes nothing.
 */
export async function commit_baselines<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  folded: readonly FoldedBaseline<M>[],
  lease: HeldOwnerLease,
): Promise<void> {
  for (const { baseline, already_stored } of folded) {
    if (already_stored) continue;
    lease.assert_held();
    await target.commit_baseline(baseline, lease);
  }
}

async function fold_baseline<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  chain_keys: readonly string[],
): Promise<FoldedBaseline<M>> {
  const fold = target.start_fold();
  let stored: M | undefined;
  for (const key of chain_keys) {
    const manifest = await read_chain_link(target, key);
    stored ??= manifest;
    fold.add(manifest);
  }
  if (stored === undefined) throw new Error('A baseline chain always holds the baseline');
  const baseline = fold.result();
  return { baseline, already_stored: target.baseline_matches(stored, baseline) };
}

async function read_chain_link<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  key: string,
): Promise<M> {
  let manifest: M | undefined;
  try {
    manifest = await target.read_manifest(key);
  } catch (err) {
    if (err instanceof UnreadableContentError) throw chain_refusal(target.label, key, err);
    throw err;
  }
  if (manifest === undefined) throw chain_refusal(target.label, key);
  return manifest;
}

function chain_refusal(label: string, key: string, cause?: Error): UnreadableObjectsError {
  return new UnreadableObjectsError(
    `Snapshots were not pruned: the oldest kept snapshot's chain needs a damaged or missing ` +
      `${label} manifest`,
    [key],
    cause ? { cause } : undefined,
  );
}
