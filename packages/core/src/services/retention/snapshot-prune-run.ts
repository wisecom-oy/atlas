import type {
  ContentSweepSkipReason,
  HeldOwnerLease,
  SnapshotPruneOptions,
  SnapshotPruneResult,
} from '@wisecom/atlas-types';
import { UnreadableObjectsError } from '@wisecom/atlas-types';
import { QUARANTINE_PREFIX } from '@/services/quarantine/stored-object-quarantine';
import {
  commit_baselines,
  fold_baselines,
  type FoldedBaseline,
} from '@/services/retention/baseline-commit';
import { is_retention_in_force } from '@/services/retention/object-lock-retention';
import { is_prune_interrupted } from '@/services/retention/prune-interruption';
import { PruneTally } from '@/services/retention/prune-tally';
import {
  remove_pruned_manifests,
  type ManifestRemoval,
} from '@/services/retention/pruned-manifest-removal';
import { planned_manifests, stored_manifests } from '@/services/retention/remaining-references';
import {
  plan_snapshot_prune,
  type SnapshotPrunePlan,
} from '@/services/retention/snapshot-prune-plan';
import type {
  PrunableManifest,
  PruneWrites,
  RetainableSnapshotSummary,
  SnapshotPruneTarget,
} from '@/services/retention/snapshot-prune-target';
import { remove_stale_satellites } from '@/services/retention/stale-satellite-removal';
import { sweep_unreferenced_content } from '@/services/retention/unreferenced-content-sweep';

const NOTHING_REMOVED: ManifestRemoval = {
  removed_snapshot_ids: [],
  retained_manifest_keys: [],
  failed_manifest_keys: [],
};

/** One prune as it is being worked out: the plan, the folded baselines and the counts so far. */
interface PruneRun<M> {
  readonly target: SnapshotPruneTarget<M & PrunableManifest>;
  readonly options: SnapshotPruneOptions;
  readonly plan: SnapshotPrunePlan<RetainableSnapshotSummary>;
  readonly folded: readonly FoldedBaseline<M>[];
  readonly tally: PruneTally;
}

/**
 * Removes an owner's snapshots older than the cut-off while the caller holds the owner's lease.
 *
 * The steps run in this order, and each leaves a state the next run can start from:
 *
 * 1. Fold each baseline's chain and write the result over the baseline's manifest. Until this
 *    lands nothing has changed; once it has, every kept snapshot resolves without the older
 *    manifests, which still exist and are now redundant.
 * 2. Delete the pruned snapshots' satellites, such as pointers, then every version of their
 *    manifests, then their summary rows. Object Lock may retain a manifest; it stays listed and
 *    is shadowed by the baseline, which carries a removal or tombstone for everything it holds.
 * 3. Delete the satellites whose snapshot is older than the cut-off and has no manifest left: drive
 *    version indexes and manifest entry parts. Found by listing, so leftovers of an interrupted
 *    run are found too.
 * 4. Delete the content that no manifest or index still in storage references.
 *
 * A repeated run folds the same chain into the same baseline, finds it stored and skips step 1,
 * then finishes whatever the interrupted run left. A dry run performs every read and no write.
 *
 * @throws UnreadableObjectsError when a manifest of the owner is damaged.
 */
export async function prune_owner_snapshots<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  lease: HeldOwnerLease,
  options: SnapshotPruneOptions,
): Promise<SnapshotPruneResult> {
  const listing = await target.list_summaries();
  if (listing.unreadable_keys.length > 0) {
    throw new UnreadableObjectsError(
      `Snapshots were not pruned: these ${target.label} manifests are damaged, and what they ` +
        'reference cannot be known until they are repaired or quarantined',
      listing.unreadable_keys,
    );
  }
  const plan = plan_snapshot_prune(listing.summaries, options.before);
  const folded = await fold_baselines(target, plan);
  const run: PruneRun<M> = { target, options, plan, folded, tally: new PruneTally() };
  // With no snapshot left to keep, every content object would count as unreferenced. Removing an
  // owner's data outright is the owner delete's job, so a prune of an owner without snapshots
  // changes nothing.
  if (plan.kept.length === 0) return build_result(run, NOTHING_REMOVED, undefined);
  return options.dry_run === true ? report_dry_run(run) : prune_and_sweep(run, lease);
}

async function prune_and_sweep<M extends PrunableManifest>(
  run: PruneRun<M>,
  lease: HeldOwnerLease,
): Promise<SnapshotPruneResult> {
  const { target, options, plan, tally } = run;
  const writes: PruneWrites = { dry_run: false, lease };
  if (is_prune_interrupted(options)) return build_result(run, NOTHING_REMOVED, 'interrupted');
  await commit_baselines(target, run.folded, lease);
  if (is_prune_interrupted(options)) return build_result(run, NOTHING_REMOVED, 'interrupted');
  const removal = await remove_pruned_manifests(target, plan.pruned, writes, tally);
  if (is_prune_interrupted(options)) return build_result(run, removal, 'interrupted');

  const remaining_ids = await snapshot_ids_with_manifests(target);
  const excluded_keys = await remove_stale_satellites(
    target,
    remaining_ids,
    options.before,
    writes,
    tally,
  );
  const sources = { remaining: stored_manifests(target), excluded_keys };
  const skipped = await sweep_unreferenced_content(target, sources, writes, tally, options);
  return build_result(run, removal, skipped);
}

async function report_dry_run<M extends PrunableManifest>(
  run: PruneRun<M>,
): Promise<SnapshotPruneResult> {
  const { target, options, plan, tally } = run;
  // Leave in place what Object Lock keeps, as the run will find: the manifest stays listed, so its
  // satellites and the content it references stay too (#975 records the retention on each row).
  const now = new Date();
  const retained = plan.pruned.filter((row) => is_retention_in_force(row.object_lock, now));
  const retained_manifest_keys = new Set(retained.map((row) => row.manifest_key));
  const writes: PruneWrites = { dry_run: true, retained_manifest_keys };
  const removal = await remove_pruned_manifests(target, plan.pruned, writes, tally);
  const remaining_rows = [...plan.kept, ...retained];
  const kept_ids = await quarantined_snapshot_ids(target);
  for (const row of remaining_rows) kept_ids.add(row.snapshot_id);
  const excluded_keys = await remove_stale_satellites(
    target,
    kept_ids,
    options.before,
    writes,
    tally,
  );
  const baselines = run.folded.map((folded) => folded.baseline);
  const sources = {
    remaining: planned_manifests(target, remaining_rows, baselines),
    excluded_keys,
  };
  const skipped = await sweep_unreferenced_content(target, sources, writes, tally, options);
  return build_result(run, removal, skipped);
}

/**
 * The ids of the snapshots whose manifest is listed, damaged or not, or moved aside by quarantine:
 * a quarantined manifest may still be repaired, and needs its satellites to be read.
 */
async function snapshot_ids_with_manifests<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
): Promise<Set<string>> {
  const ids = await quarantined_snapshot_ids(target);
  for (const id of await listed_snapshot_ids(target, target.manifest_prefix)) ids.add(id);
  return ids;
}

async function quarantined_snapshot_ids<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
): Promise<Set<string>> {
  return new Set(
    await listed_snapshot_ids(target, `${QUARANTINE_PREFIX}${target.manifest_prefix}`),
  );
}

/** Snapshot ids from the manifest keys directly under `prefix`; a second quarantined copy too. */
async function listed_snapshot_ids<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  prefix: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const key of await target.ctx.storage.list(prefix)) {
    const match = /^([^/]+)\.json(?:\.\d+)?$/.exec(key.slice(prefix.length));
    if (match?.[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

function build_result<M extends PrunableManifest>(
  run: PruneRun<M>,
  removal: ManifestRemoval,
  skipped: ContentSweepSkipReason | undefined,
): SnapshotPruneResult {
  return {
    ...run.tally.counts,
    dry_run: run.options.dry_run === true,
    before: run.options.before,
    baseline_snapshot_ids: run.plan.baselines.map((row) => row.snapshot_id),
    removed_snapshot_ids: removal.removed_snapshot_ids,
    retained_manifest_keys: removal.retained_manifest_keys,
    failed_manifest_keys: removal.failed_manifest_keys,
    deleted_bytes: run.tally.deleted_bytes,
    ...(skipped !== undefined && { content_sweep_skipped: skipped }),
    interrupted: skipped === 'interrupted',
  };
}
