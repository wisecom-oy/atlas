import type { Manifest, ManifestRepository, TenantContext } from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import { replicate_snapshot_to_target } from '@/services/replication/snapshot-replicator';
import type { SnapshotChainCopyPlan } from '@/services/replication/snapshot-chain-copier';

export const OUTLOOK_MANIFEST_PREFIX = 'manifests';

/** Storage key of an Outlook snapshot's manifest. */
function outlook_manifest_key(manifest: Manifest): string {
  return `${OUTLOOK_MANIFEST_PREFIX}/${manifest.owner_id}/${manifest.snapshot_id}.json`;
}

/** How the Outlook workload plugs into the chain copier when copying to a replica. */
export const OUTLOOK_REPLICATION: SnapshotChainCopyPlan<Manifest> = {
  manifest_key: outlook_manifest_key,
  owner_of: (manifest) => manifest.owner_id,
  copy: (source_ctx, target_ctx, manifest) =>
    replicate_snapshot_to_target(source_ctx, target_ctx, manifest),
};

/**
 * How the Outlook workload plugs into the chain copier when recovering to the primary: no replica
 * marker, so recovered data on primary is not labelled as a replica of itself.
 */
export const OUTLOOK_REHYDRATION: SnapshotChainCopyPlan<Manifest> = {
  ...OUTLOOK_REPLICATION,
  copy: (source_ctx, primary_ctx, manifest) =>
    replicate_snapshot_to_target(source_ctx, primary_ctx, manifest, { skip_marker: true }),
};

/** Loads an Outlook manifest by snapshot ID, throwing a located error when it is absent. */
export async function require_outlook_manifest(
  repo: ManifestRepository,
  ctx: TenantContext,
  snapshot_id: string,
  location?: 'source',
): Promise<Manifest> {
  const manifest = await repo.find_by_snapshot(ctx, snapshot_id);
  if (!manifest) {
    const where = location === 'source' ? ' on source' : '';
    throw new NotFoundError(`No manifest found for snapshot ${snapshot_id}${where}`);
  }
  return manifest;
}

/** Lists a mailbox's manifests oldest-first, so replication replays snapshots in order. */
export async function list_mailbox_manifests(
  repo: ManifestRepository,
  ctx: TenantContext,
  owner_id: string,
): Promise<Manifest[]> {
  const manifests = await repo.list_by_owner(ctx, owner_id);
  return manifests.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}
