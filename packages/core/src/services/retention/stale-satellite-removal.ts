import {
  settle_versions,
  versions_under,
  type PruneTally,
  type PrunableVersion,
} from '@/services/retention/prune-tally';
import { assert_lease_held } from '@/services/retention/pruned-manifest-removal';
import type {
  PrunableManifest,
  PruneWrites,
  SnapshotPruneTarget,
  StaleSatellitePrefix,
} from '@/services/retention/snapshot-prune-target';

/**
 * Removes the satellite objects of snapshots taken before the cut-off whose manifest no longer
 * exists: the drive run version indexes and manifest entry parts. `remaining_snapshot_ids` are the
 * snapshots with a manifest after the manifests were removed, or for a dry run the ones it keeps.
 *
 * Returns the keys removed, or that a dry run would remove, so the reference scan can leave them
 * out. A key Object Lock retains is not returned: it still exists and still references content.
 */
export async function remove_stale_satellites<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  remaining_snapshot_ids: ReadonlySet<string>,
  before: Date,
  writes: PruneWrites,
  tally: PruneTally,
): Promise<Set<string>> {
  const removed = new Set<string>();
  const retained_or_failed = new Set<string>();
  for (const satellite of target.stale_satellites) {
    assert_lease_held(writes);
    const storage = target.ctx.storage;
    const stale = only_stale(
      versions_under(storage, satellite.prefix),
      satellite,
      remaining_snapshot_ids,
      before.getTime(),
    );
    await settle_versions(storage, stale, tally, writes.dry_run, (version, outcome) => {
      if (outcome === 'deleted') removed.add(version.key);
      else retained_or_failed.add(version.key);
    });
  }
  for (const key of retained_or_failed) removed.delete(key);
  return removed;
}

async function* only_stale(
  versions: AsyncIterable<PrunableVersion>,
  satellite: StaleSatellitePrefix,
  remaining_snapshot_ids: ReadonlySet<string>,
  cutoff: number,
): AsyncGenerator<PrunableVersion> {
  for await (const version of versions) {
    if (is_stale(version.key, satellite, remaining_snapshot_ids, cutoff)) yield version;
  }
}

/** Taken before the cut-off, by the epoch in its id, and without a manifest any more. */
function is_stale(
  key: string,
  satellite: StaleSatellitePrefix,
  remaining_snapshot_ids: ReadonlySet<string>,
  cutoff: number,
): boolean {
  const snapshot_id = satellite.snapshot_of(key);
  if (snapshot_id === undefined || remaining_snapshot_ids.has(snapshot_id)) return false;
  const taken_at = satellite.taken_at(snapshot_id);
  return taken_at !== undefined && taken_at < cutoff;
}
