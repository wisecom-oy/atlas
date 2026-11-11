import {
  fold_drive_snapshot_chain,
  select_drive_manifest_chain,
} from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { DriveChainEntry } from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { ReadableManifestListing, TenantContext } from '@wisecom/atlas-types';
import { NotFoundError, UnreadableObjectsError } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';

/**
 * Manifest lookups for one owning segment. The two providers name the listing after what they own
 * (`list_readable_snapshots_by_owner`, `list_readable_snapshots_by_site`), so the caller passes the
 * pair rather than the repository.
 */
export interface DriveManifestLookup<TManifest> {
  /** Workload name for operator-facing errors: the message has always named it. */
  readonly workload: string;
  readonly find_by_snapshot: (
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ) => Promise<TManifest | undefined>;
  readonly list_readable_snapshots: (
    ctx: TenantContext,
    owner_id: string,
  ) => Promise<ReadableManifestListing<TManifest>>;
}

/** What the fold needs from a manifest, which is all either provider's manifest has to supply. */
export interface DriveChainManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly entries: readonly DriveManifestEntry[];
}

export type DriveChainEntryRow = DriveChainEntry<DriveManifestEntry>;

/** A resolved snapshot: its manifest, the folded entries, and damaged manifests it did not need. */
export interface DriveChainResolution<TManifest> {
  readonly manifest: TManifest;
  readonly entries: DriveChainEntryRow[];
  /** Damaged manifests newer than the target, which its chain never reads (issue #631). */
  readonly unreadable_keys: string[];
}

/**
 * Resolves a snapshot to the newest state of every file the owner had at that point.
 *
 * A drive manifest holds one delta, so reading it alone loses every file that last changed in an
 * earlier run (issue #173). This loads the target manifest plus every older manifest for the same
 * owner and folds them newest-first.
 *
 * A damaged manifest is placed in time by the epoch in its snapshot id. One newer than the target
 * is outside the chain and is only reported. One at or before the target, or one whose key carries
 * no epoch, may hold the newest state of some file or the tombstone hiding a deleted one, so the
 * resolution is refused with its key named rather than answered with older data (issue #631).
 */
export async function load_drive_chain_entries<TManifest extends DriveChainManifest>(
  manifests: DriveManifestLookup<TManifest>,
  ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
): Promise<DriveChainResolution<TManifest>> {
  const target = await manifests.find_by_snapshot(ctx, owner_id, snapshot_id);
  if (!target) {
    throw new NotFoundError(`No ${manifests.workload} manifest found for snapshot ${snapshot_id}`);
  }

  const listing = await manifests.list_readable_snapshots(ctx, owner_id);
  const target_time = target.created_at.getTime();
  const needed = listing.unreadable_keys.filter((key) => !is_newer_than(key, target_time));
  if (needed.length > 0) {
    throw new UnreadableObjectsError(
      `Snapshot ${snapshot_id} cannot be resolved: its chain needs damaged ` +
        `${manifests.workload} manifest(s)`,
      needed,
    );
  }
  const chain = select_drive_manifest_chain(listing.manifests, target);
  return {
    manifest: target,
    entries: fold_drive_snapshot_chain(chain),
    unreadable_keys: listing.unreadable_keys,
  };
}

/** Epoch milliseconds in a `<workload>-snap-{epoch}-{suffix}.json` key; undefined without one. */
export function snapshot_epoch_of_key(key: string): number | undefined {
  const match = /-snap-(\d+)-[^/]*\.json$/.exec(key);
  return match ? Number(match[1]) : undefined;
}

/** Whether a manifest key's snapshot was taken strictly after `time`; unknown counts as not. */
function is_newer_than(key: string, time: number): boolean {
  const epoch = snapshot_epoch_of_key(key);
  return epoch !== undefined && epoch > time;
}

/** Drops tombstones and entries with no stored blob: what a restore or export can actually write. */
export function restorable_entries(entries: readonly DriveChainEntryRow[]): DriveManifestEntry[] {
  return entries
    .filter(({ entry }) => entry.change_type !== 'deleted' && entry.storage_key)
    .map(({ entry }) => entry);
}
