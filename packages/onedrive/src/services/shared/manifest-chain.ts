import {
  fold_drive_snapshot_chain,
  select_drive_manifest_chain,
} from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { DriveChainEntry } from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type {
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';

export type OneDriveChainEntry = DriveChainEntry<OneDriveManifestEntry>;

/**
 * Resolves a snapshot to the newest state of every file the owner had at that point.
 *
 * A OneDrive manifest holds one delta, so reading it alone loses every file that last changed in an
 * earlier run (issue #173). This loads the target manifest plus every older manifest for the same
 * owner and folds them newest-first.
 */
export async function load_onedrive_chain_entries(
  manifests: OneDriveManifestRepository,
  ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
): Promise<{ manifest: OneDriveSnapshotManifest; entries: OneDriveChainEntry[] }> {
  const target = await manifests.find_by_snapshot(ctx, owner_id, snapshot_id);
  if (!target) {
    throw new Error(`No OneDrive manifest found for snapshot ${snapshot_id}`);
  }

  const all = await manifests.list_snapshots_by_owner(ctx, owner_id);
  const chain = select_drive_manifest_chain(all, target);
  return { manifest: target, entries: fold_drive_snapshot_chain(chain) };
}

/** Drops tombstones and entries with no stored blob: what a restore or export can actually write. */
export function restorable_entries(
  entries: readonly OneDriveChainEntry[],
): OneDriveManifestEntry[] {
  return entries
    .filter(({ entry }) => entry.change_type !== 'deleted' && entry.storage_key)
    .map(({ entry }) => entry);
}
