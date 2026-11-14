import { fold_drive_snapshot_chain } from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import type { DriveChainEntry } from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';
import {
  load_drive_manifest_chain,
  type DriveManifestLookup,
} from '@wisecom/atlas-core/services/shared/drive-manifest-chain-loader';
import type { TenantContext } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';

export type { DriveManifestLookup };

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
 * earlier run (issue #173). The chain loader returns the target plus every older manifest of the
 * owner, refusing when one it needs is damaged (issue #631), and this folds it newest-first.
 */
export async function load_drive_chain_entries<TManifest extends DriveChainManifest>(
  manifests: DriveManifestLookup<TManifest>,
  ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
): Promise<DriveChainResolution<TManifest>> {
  const chain = await load_drive_manifest_chain(manifests, ctx, owner_id, snapshot_id);
  return {
    manifest: chain.target,
    entries: fold_drive_snapshot_chain(chain.manifests),
    unreadable_keys: chain.unreadable_keys,
  };
}

/** Drops tombstones and entries with no stored blob: what a restore or export can actually write. */
export function restorable_entries(entries: readonly DriveChainEntryRow[]): DriveManifestEntry[] {
  return entries
    .filter(({ entry }) => entry.change_type !== 'deleted' && entry.storage_key)
    .map(({ entry }) => entry);
}
