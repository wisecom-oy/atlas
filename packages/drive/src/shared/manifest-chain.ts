import {
  fold_drive_snapshot_chain,
  select_drive_manifest_chain,
} from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { DriveChainEntry } from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { TenantContext } from '@wisecom/atlas-types';
import type { DriveManifestEntry, DriveSnapshotManifest } from '@/drive-ports';

/**
 * Manifest lookups for one owning segment. The two providers name the listing after what they own
 * (`list_snapshots_by_owner`, `list_snapshots_by_site`), so the caller passes the pair rather than
 * the repository.
 */
export interface DriveManifestLookup<TManifest> {
  /** Workload name for operator-facing errors: the message has always named it. */
  readonly workload: string;
  readonly find_by_snapshot: (
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ) => Promise<TManifest | undefined>;
  readonly list_snapshots: (ctx: TenantContext, owner_id: string) => Promise<TManifest[]>;
}

/** What the fold needs from a manifest, which is all either provider's manifest has to supply. */
export interface DriveChainManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly entries: readonly DriveManifestEntry[];
}

export type DriveChainEntryRow = DriveChainEntry<DriveManifestEntry>;

/**
 * Resolves a snapshot to the newest state of every file the owner had at that point.
 *
 * A drive manifest holds one delta, so reading it alone loses every file that last changed in an
 * earlier run (issue #173). This loads the target manifest plus every older manifest for the same
 * owner and folds them newest-first.
 */
export async function load_drive_chain_entries<TManifest extends DriveChainManifest>(
  manifests: DriveManifestLookup<TManifest>,
  ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
): Promise<{ manifest: TManifest; entries: DriveChainEntryRow[] }> {
  const target = await manifests.find_by_snapshot(ctx, owner_id, snapshot_id);
  if (!target) {
    throw new Error(`No ${manifests.workload} manifest found for snapshot ${snapshot_id}`);
  }

  const all = await manifests.list_snapshots(ctx, owner_id);
  const chain = select_drive_manifest_chain(all, target);
  return { manifest: target, entries: fold_drive_snapshot_chain(chain) };
}

/** Drops tombstones and entries with no stored blob: what a restore or export can actually write. */
export function restorable_entries(entries: readonly DriveChainEntryRow[]): DriveManifestEntry[] {
  return entries
    .filter(({ entry }) => entry.change_type !== 'deleted' && entry.storage_key)
    .map(({ entry }) => entry);
}
