import type { SnapshotChainWording } from '@wisecom/atlas-types';
import { SnapshotNotNewestError, UnreadableObjectsError } from '@wisecom/atlas-types';

/** What the order check needs from a manifest of any workload whose snapshots form a chain. */
export interface OrderedSnapshot {
  readonly snapshot_id: string;
  readonly created_at: Date;
}

/**
 * Refuses to delete a snapshot that newer snapshots of the same owner build on.
 *
 * Outlook, OneDrive and SharePoint manifests hold only their own run's changes, and every newer
 * snapshot is that chain folded together. Deleting an older link would drop the items it recorded
 * from every later snapshot and bring back the ones it recorded as removed (issues #704, #725). A
 * manifest's `created_at` is inside its ciphertext, so a damaged manifest of the owner makes the
 * order unknowable: the delete is refused until that manifest is quarantined.
 *
 * Ties count as newer, matching `load_snapshot_chain` and `select_drive_manifest_chain`, which
 * fold a same-time manifest into the target's chain.
 *
 * @param list_owner_manifests Every manifest of the owner; rejects with `UnreadableObjectsError`
 *   when one is damaged.
 * @param wording How the refusal names the owner, defaulting to an Outlook mailbox.
 */
export async function assert_snapshot_is_newest<M extends OrderedSnapshot>(
  target: M,
  list_owner_manifests: () => Promise<readonly M[]>,
  wording?: SnapshotChainWording,
): Promise<void> {
  const owned = await list_owner_chain_for_delete(target, list_owner_manifests, wording);
  const target_time = target.created_at.getTime();
  const newer_snapshot_ids = owned
    .filter((m) => m.snapshot_id !== target.snapshot_id && m.created_at.getTime() >= target_time)
    .map((m) => m.snapshot_id);
  if (newer_snapshot_ids.length > 0) {
    throw new SnapshotNotNewestError(
      target.snapshot_id,
      newer_snapshot_ids,
      wording === undefined ? undefined : { wording },
    );
  }
}

/** Lists the owner's manifests, naming every damaged one when the order cannot be checked. */
async function list_owner_chain_for_delete<M extends OrderedSnapshot>(
  target: M,
  list_owner_manifests: () => Promise<readonly M[]>,
  wording: SnapshotChainWording | undefined,
): Promise<readonly M[]> {
  try {
    return await list_owner_manifests();
  } catch (err) {
    if (!(err instanceof UnreadableObjectsError)) throw err;
    throw new UnreadableObjectsError(
      `Snapshot ${target.snapshot_id} was not deleted: whether newer snapshots depend on it ` +
        `cannot be checked until these damaged manifests of the ${wording?.owner ?? 'mailbox'} ` +
        `are quarantined`,
      err.unreadable_keys,
      { cause: err },
    );
  }
}
