import type { Manifest, ManifestRepository, TenantContext } from '@wisecom/atlas-types';
import { SnapshotNotNewestError, UnreadableObjectsError } from '@wisecom/atlas-types';

/**
 * Refuses to delete an Outlook snapshot that newer snapshots of the same mailbox build on.
 *
 * An Outlook manifest holds only its own run's changes, and every newer snapshot is that chain
 * folded together. Deleting an older link would drop the messages it recorded from every later
 * snapshot and bring back the ones it recorded as removed (issue #704). A manifest's
 * `created_at` is inside its ciphertext, so a damaged manifest of the mailbox makes the order
 * unknowable: the delete is refused until that manifest is quarantined.
 *
 * Ties count as newer, matching `load_snapshot_chain`, which folds a same-time manifest into the
 * target's chain.
 */
export async function assert_outlook_snapshot_is_newest(
  manifests: ManifestRepository,
  ctx: TenantContext,
  target: Manifest,
): Promise<void> {
  const owned = await list_owner_chain_for_delete(manifests, ctx, target);
  const target_time = target.created_at.getTime();
  const newer_snapshot_ids = owned
    .filter((m) => m.snapshot_id !== target.snapshot_id && m.created_at.getTime() >= target_time)
    .map((m) => m.snapshot_id);
  if (newer_snapshot_ids.length > 0) {
    throw new SnapshotNotNewestError(target.snapshot_id, newer_snapshot_ids);
  }
}

/** Lists the mailbox's manifests, naming every damaged one when the order cannot be checked. */
async function list_owner_chain_for_delete(
  manifests: ManifestRepository,
  ctx: TenantContext,
  target: Manifest,
): Promise<Manifest[]> {
  try {
    return await manifests.list_by_owner(ctx, target.owner_id);
  } catch (err) {
    if (!(err instanceof UnreadableObjectsError)) throw err;
    throw new UnreadableObjectsError(
      `Snapshot ${target.snapshot_id} was not deleted: whether newer snapshots depend on it ` +
        `cannot be checked until these damaged manifests of the mailbox are quarantined`,
      err.unreadable_keys,
      { cause: err },
    );
  }
}
