import type { Manifest, ManifestRepository, TenantContext } from '@wisecom/atlas-types';

/**
 * Loads a snapshot's manifest plus every older manifest of the same mailbox, target first, then
 * newest-first. An Outlook manifest holds only that run's delta, so this chain is what a snapshot
 * actually contains. Verify, restore and save all read it, so the three cannot drift (issue #432).
 */
export async function load_snapshot_chain(
  manifests: ManifestRepository,
  ctx: TenantContext,
  snapshot_id: string,
): Promise<Manifest[]> {
  const target = await manifests.find_by_snapshot(ctx, snapshot_id);
  if (!target) throw new Error(`No manifest found for snapshot ${snapshot_id}`);

  const target_time = new Date(target.created_at).getTime();
  const all = await manifests.list_all_manifests(ctx);
  const older = all
    .filter(
      (m) =>
        m.snapshot_id !== target.snapshot_id &&
        m.owner_id === target.owner_id &&
        new Date(m.created_at).getTime() <= target_time,
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return [target, ...older];
}
