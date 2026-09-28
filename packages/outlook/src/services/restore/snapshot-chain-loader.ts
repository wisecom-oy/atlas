import { NotFoundError } from '@wisecom/atlas-types';
import type { Manifest, ManifestRepository, TenantContext } from '@wisecom/atlas-types';

/**
 * Loads a snapshot and every older manifest of the same mailbox, newest first: the state as of
 * that snapshot. Newer snapshots and other mailboxes are excluded.
 */
export async function load_snapshot_chain(
  manifests: ManifestRepository,
  ctx: TenantContext,
  snapshot_id: string,
): Promise<Manifest[]> {
  const target = await manifests.find_by_snapshot(ctx, snapshot_id);
  if (!target) throw new NotFoundError(`No manifest found for snapshot ${snapshot_id}`);
  const all = await manifests.list_all_manifests(ctx);
  const older = all.filter(
    (manifest) =>
      manifest.snapshot_id !== target.snapshot_id &&
      manifest.owner_id === target.owner_id &&
      new Date(manifest.created_at).getTime() <= new Date(target.created_at).getTime(),
  );
  return [target, ...older].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
