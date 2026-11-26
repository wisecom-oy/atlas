import type {
  HeldOwnerLease,
  ReadableSnapshotSummaries,
  ReadableVersionIndexListing,
  SnapshotSummary,
  TenantContext,
} from '@wisecom/atlas-types';
import { quarantined_copies_of } from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import type {
  SnapshotPruneTarget,
  StaleSatellitePrefix,
} from '@wisecom/atlas-core/services/retention/snapshot-prune-target';
import type { DriveFileVersionIndexView } from '@/drive-ports';
import type { DriveStorageKeys } from '@/shared/storage-keys';
import { baseline_run_index, type RowSourceEntry } from '@/retention/baseline-version-rows';
import {
  DriveBaselineFold,
  drive_baseline_matches,
  type FoldableDriveManifest,
} from '@/retention/drive-baseline-fold';
import { add_index_references } from '@/retention/drive-index-references';

/**
 * One drive owner or site as the prune sees it. OneDrive and SharePoint pass their repositories'
 * methods bound to the tenant and owning segment, the way `delete_newest_drive_snapshot` takes them.
 */
export interface DrivePruneOwner<M extends FoldableDriveManifest<RowSourceEntry>> {
  /** Provider name for operator-facing messages, e.g. `OneDrive`. */
  readonly label: string;
  readonly ctx: TenantContext;
  readonly keys: DriveStorageKeys;
  /** The normalized owner or site id. */
  readonly owner_id: string;
  readonly list_summaries: () => Promise<ReadableSnapshotSummaries<SnapshotSummary>>;
  readonly read_manifest: (key: string) => Promise<M | undefined>;
  readonly replace_with_baseline: (manifest: M, lease: HeldOwnerLease) => Promise<void>;
  readonly forget_rows: (snapshot_ids: readonly string[], lease: HeldOwnerLease) => Promise<void>;
  /** Every file's rows across the owner's index objects, naming the unreadable ones. */
  readonly list_indexes: () => Promise<ReadableVersionIndexListing<DriveFileVersionIndexView>>;
  /** One index object; undefined when absent, `UnreadableContentError` when damaged. */
  readonly read_index_object: (key: string) => Promise<DriveFileVersionIndexView[] | undefined>;
  readonly replace_run_index: (
    snapshot_id: string,
    indexes: DriveFileVersionIndexView[],
  ) => Promise<void>;
}

/**
 * Builds the prune's view of a drive owner. Content blobs live under `data/{owner}/`, referenced
 * by manifest entries and by version index rows. The delta cursor is bound to the newest
 * snapshot, which a prune never removes, so it is left alone and the next backup resumes from it.
 */
export function drive_prune_target<M extends FoldableDriveManifest<RowSourceEntry>>(
  owner: DrivePruneOwner<M>,
): SnapshotPruneTarget<M> {
  const { keys, owner_id } = owner;
  const manifest_prefix = keys.manifest_prefix_for(owner_id);
  const index_prefix = keys.index_prefix_for(owner_id);
  return {
    label: owner.label,
    ctx: owner.ctx,
    manifest_prefix,
    content_prefixes: [keys.data_prefix_for(owner_id)],
    quarantine_prefixes: quarantined_copies_of([manifest_prefix, index_prefix]),
    stale_satellites: [
      satellite_of(`${index_prefix}runs/`, (name) => strip_json(name)),
      satellite_of(keys.manifest_parts_prefix_for(owner_id), (name) => name.split('/')[0]),
    ],
    list_summaries: owner.list_summaries,
    read_manifest: owner.read_manifest,
    start_fold: () => new DriveBaselineFold<RowSourceEntry, M>(),
    baseline_matches: drive_baseline_matches,
    commit_baseline: (baseline, lease) => commit_drive_baseline(owner, baseline, lease),
    satellite_scopes: () => [],
    forget_rows: owner.forget_rows,
    add_references: (manifest, references): void => {
      for (const entry of manifest.entries) references.add(entry.storage_key);
    },
    add_external_references: (references, excluded_keys) =>
      add_index_references(owner, index_prefix, references, excluded_keys),
  };
}

/**
 * Gives the baseline's run index a row for every entry it carries, then writes the baseline over
 * the manifest. The rows go first: until the manifest lands they are extra rows under a snapshot
 * whose entries do not yet name those files, which no reader trips over.
 *
 * An index object that cannot be read may already hold a row under the baseline; the row is then
 * written again, which only repeats it in `versions`. The content sweep refuses to run on its own
 * while that object stays unreadable.
 */
async function commit_drive_baseline<M extends FoldableDriveManifest<RowSourceEntry>>(
  owner: DrivePruneOwner<M>,
  baseline: M,
  lease: HeldOwnerLease,
): Promise<void> {
  const history = await owner.list_indexes();
  const run_index_key = owner.keys.run_index_key(owner.owner_id, baseline.snapshot_id);
  const stored = (await owner.read_index_object(run_index_key)) ?? [];
  const indexes = baseline_run_index(
    baseline.snapshot_id,
    baseline.entries,
    stored,
    history.indexes,
  );
  lease.assert_held();
  if (indexes !== undefined) await owner.replace_run_index(baseline.snapshot_id, indexes);
  await owner.replace_with_baseline(baseline, lease);
}

/** A stale-satellite prefix whose keys name their snapshot as `name_to_snapshot` reads them. */
function satellite_of(
  prefix: string,
  name_to_snapshot: (name: string) => string | undefined,
): StaleSatellitePrefix {
  return {
    prefix,
    snapshot_of: (key) =>
      key.startsWith(prefix) ? name_to_snapshot(key.slice(prefix.length)) : undefined,
    taken_at: snapshot_epoch_of_id,
  };
}

function strip_json(name: string): string | undefined {
  return name.endsWith('.json') && !name.includes('/') ? name.slice(0, -'.json'.length) : undefined;
}

/** The epoch milliseconds in a drive snapshot id (`od-snap-{epoch}-{suffix}`), its `created_at`. */
export function snapshot_epoch_of_id(snapshot_id: string): number | undefined {
  const match = /-snap-(\d+)-/.exec(snapshot_id);
  return match ? Number(match[1]) : undefined;
}
