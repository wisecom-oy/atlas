import type { SnapshotSummary, StorageDeleteOutcome } from '@wisecom/atlas-types';
import {
  settle_versions,
  versions_under,
  type PrunableVersion,
  type PruneTally,
} from '@/services/retention/prune-tally';
import type {
  PrunableManifest,
  PruneWrites,
  SnapshotPruneTarget,
} from '@/services/retention/snapshot-prune-target';

/** What became of the manifests of the snapshots older than the cut-off. */
export interface ManifestRemoval {
  /** Snapshots whose manifest has no version left, or would have none after a dry run. */
  readonly removed_snapshot_ids: string[];
  /** Manifests Object Lock still retains. */
  readonly retained_manifest_keys: string[];
  /** Manifests whose deletion failed for another reason. */
  readonly failed_manifest_keys: string[];
}

/**
 * Removes the pruned snapshots: their satellite objects, then every version of their manifests,
 * then their summary rows in one rewrite. The baselines must already be committed, because from
 * here on the kept snapshots no longer find the pruned manifests.
 *
 * A manifest any of whose versions Object Lock refuses to delete stays listed, and its row stays
 * with it; a later run removes it once its retention ends. A dry run only counts.
 */
export async function remove_pruned_manifests<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  pruned: readonly SnapshotSummary[],
  writes: PruneWrites,
  tally: PruneTally,
): Promise<ManifestRemoval> {
  if (pruned.length === 0) {
    return { removed_snapshot_ids: [], retained_manifest_keys: [], failed_manifest_keys: [] };
  }
  const storage = target.ctx.storage;
  assert_lease_held(writes);
  for (const scope of pruned.flatMap((s) => target.satellite_scopes(s.snapshot_id))) {
    await settle_versions(storage, versions_under(storage, scope), tally, writes.dry_run);
  }
  assert_lease_held(writes);
  const outcomes = await delete_manifest_versions(target, pruned, tally, writes.dry_run);
  const removal = classify_removal(pruned, outcomes);
  if (!writes.dry_run) await target.forget_rows(removal.removed_snapshot_ids, writes.lease);
  return removal;
}

/** Checks the lease of a run that writes; a dry run holds nothing to check. */
export function assert_lease_held(writes: PruneWrites): void {
  if (!writes.dry_run) writes.lease.assert_held();
}

/** Deletes every version of the pruned manifests, from one listing of the owner's manifests. */
async function delete_manifest_versions<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  pruned: readonly SnapshotSummary[],
  tally: PruneTally,
  dry_run: boolean,
): Promise<Map<string, StorageDeleteOutcome>> {
  const pruned_keys = new Set(pruned.map((s) => s.manifest_key));
  const outcomes = new Map<string, StorageDeleteOutcome>();
  const listing = versions_under(target.ctx.storage, target.manifest_prefix);
  await settle_versions(
    target.ctx.storage,
    only_keys(listing, pruned_keys),
    tally,
    dry_run,
    (version, outcome) => outcomes.set(version.key, worse_of(outcomes.get(version.key), outcome)),
  );
  return outcomes;
}

async function* only_keys(
  versions: AsyncIterable<PrunableVersion>,
  keys: ReadonlySet<string>,
): AsyncGenerator<PrunableVersion> {
  for await (const version of versions) {
    if (keys.has(version.key)) yield version;
  }
}

/** A key is as bad as its worst version: one failed version fails it, one retained retains it. */
function worse_of(
  current: StorageDeleteOutcome | undefined,
  next: StorageDeleteOutcome,
): StorageDeleteOutcome {
  const rank: Record<StorageDeleteOutcome, number> = { deleted: 0, retained: 1, failed: 2 };
  return current !== undefined && rank[current] >= rank[next] ? current : next;
}

/** Sorts the pruned snapshots by their manifest's outcome; one with no version left is removed. */
function classify_removal(
  pruned: readonly SnapshotSummary[],
  outcomes: ReadonlyMap<string, StorageDeleteOutcome>,
): ManifestRemoval {
  const removal: ManifestRemoval = {
    removed_snapshot_ids: [],
    retained_manifest_keys: [],
    failed_manifest_keys: [],
  };
  for (const snapshot of pruned) {
    const outcome = outcomes.get(snapshot.manifest_key) ?? 'deleted';
    if (outcome === 'deleted') removal.removed_snapshot_ids.push(snapshot.snapshot_id);
    else if (outcome === 'retained') removal.retained_manifest_keys.push(snapshot.manifest_key);
    else removal.failed_manifest_keys.push(snapshot.manifest_key);
  }
  return removal;
}
