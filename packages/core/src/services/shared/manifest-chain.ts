import type {
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';

/**
 * Loads a snapshot's manifest plus every older manifest of the same mailbox, target first, then
 * newest-first. An Outlook manifest holds only that run's delta, so this chain is what a snapshot
 * actually contains. Verify, restore and save all read it, so the three cannot drift (issue #432).
 * Only the target's own `manifests/{owner_id}/` prefix is read, never the whole tenant (issue #510).
 */
export async function load_snapshot_chain(
  manifests: ManifestRepository,
  ctx: TenantContext,
  snapshot_id: string,
): Promise<Manifest[]> {
  const target = await manifests.find_by_snapshot(ctx, snapshot_id);
  if (!target) throw new NotFoundError(`No manifest found for snapshot ${snapshot_id}`);

  const target_time = target.created_at.getTime();
  const for_owner = await manifests.list_by_owner(ctx, target.owner_id);
  const older = for_owner
    .filter((m) => m.snapshot_id !== target.snapshot_id && m.created_at.getTime() <= target_time)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return [target, ...older];
}

/**
 * Finds a message in a snapshot's merged chain. A 1-based index counts the target manifest, the
 * list `outlook list -s` prints, so an index never means a different message between commands. An
 * `object_id` matches anywhere in the chain, which is how a message carried over from an earlier
 * run is addressed. `merged` comes from `merge_snapshot_entries`, so removed messages never match.
 */
export function resolve_message_ref(
  target: Manifest,
  merged: ManifestEntry[],
  ref: string,
): ManifestEntry | undefined {
  const index = Number(ref);
  const object_id =
    Number.isInteger(index) && index >= 1 ? target.entries[index - 1]?.object_id : ref;
  return merged.find((e) => e.object_id === object_id);
}
