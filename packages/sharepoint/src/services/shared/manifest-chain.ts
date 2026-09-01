import {
  fold_drive_snapshot_chain,
  select_drive_manifest_chain,
} from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { DriveChainEntry } from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type {
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';

export type SharePointChainEntry = DriveChainEntry<SharePointManifestEntry>;

/**
 * Resolves a snapshot to the newest state of every file the site had at that point.
 *
 * A SharePoint manifest holds one delta, so reading it alone loses every file that last changed in
 * an earlier run (issue #173). This loads the target manifest plus every older manifest for the
 * same site and folds them newest-first.
 */
export async function load_sharepoint_chain_entries(
  manifests: SharePointManifestRepository,
  ctx: TenantContext,
  site_id: string,
  snapshot_id: string,
): Promise<{ manifest: SharePointSnapshotManifest; entries: SharePointChainEntry[] }> {
  const target = await manifests.find_by_snapshot(ctx, site_id, snapshot_id);
  if (!target) {
    throw new Error(`No SharePoint manifest found for snapshot ${snapshot_id}`);
  }

  const all = await manifests.list_snapshots_by_site(ctx, site_id);
  const chain = select_drive_manifest_chain(all, target);
  return { manifest: target, entries: fold_drive_snapshot_chain(chain) };
}

/** Drops tombstones and entries with no stored blob: what a restore or export can actually write. */
export function restorable_entries(
  entries: readonly SharePointChainEntry[],
): SharePointManifestEntry[] {
  return entries
    .filter(({ entry }) => entry.change_type !== 'deleted' && entry.storage_key)
    .map(({ entry }) => entry);
}
