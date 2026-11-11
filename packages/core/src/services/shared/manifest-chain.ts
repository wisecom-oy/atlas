import type {
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { NotFoundError, UnreadableObjectsError } from '@wisecom/atlas-types';

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
  const for_owner = await list_whole_chain(manifests, ctx, target.owner_id, snapshot_id);
  const older = for_owner
    .filter((m) => m.snapshot_id !== target.snapshot_id && m.created_at.getTime() <= target_time)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return [target, ...older];
}

/**
 * Lists every manifest of the owner, refusing when any is damaged.
 *
 * A damaged manifest's `created_at` is inside the ciphertext and an Outlook snapshot id carries no
 * time, so nothing says whether it is older than the target. If it is, the target's chain needs
 * it: its messages, and the removals that hide deleted ones, exist nowhere else. Leaving it out
 * would restore a different mailbox than the one backed up, so the chain is refused with every
 * damaged key named rather than resolved without them (issue #631).
 */
async function list_whole_chain(
  manifests: ManifestRepository,
  ctx: TenantContext,
  owner_id: string,
  snapshot_id: string,
): Promise<Manifest[]> {
  try {
    return await manifests.list_by_owner(ctx, owner_id);
  } catch (err) {
    if (!(err instanceof UnreadableObjectsError)) throw err;
    throw new UnreadableObjectsError(
      `Snapshot ${snapshot_id} cannot be resolved: its chain may need a damaged Outlook manifest`,
      err.unreadable_keys,
      { cause: err },
    );
  }
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
