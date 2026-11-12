import type {
  DeletionResult,
  HeldOwnerLease,
  SnapshotChainWording,
  TenantContext,
} from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import {
  delete_scopes,
  delete_snapshot_manifest,
  has_survivors,
  merge_deletion_results,
} from '@/services/deletion/shared/prefix-deleter';
import {
  assert_snapshot_is_newest,
  type OrderedSnapshot,
} from '@/services/deletion/snapshot-order-guard';

/**
 * One drive provider's snapshot to delete. OneDrive and SharePoint differ only in the namespace,
 * the name shown to the operator, and which repository reads name the owning segment.
 */
export interface DriveSnapshotDeletion<M extends OrderedSnapshot> {
  /** Storage namespace: `onedrive` or `sharepoint`. */
  readonly workload: string;
  /** Provider name for operator-facing messages, e.g. `OneDrive`. */
  readonly label: string;
  /** The normalized owner or site id. */
  readonly owner_id: string;
  readonly snapshot_id: string;
  readonly wording: SnapshotChainWording;
  /** The owner's lease, checked once the order is known and before anything is deleted. */
  readonly lease: HeldOwnerLease;
  /** Reads the snapshot's manifest; undefined when absent, rejects when it is damaged. */
  readonly find_snapshot: () => Promise<M | undefined>;
  /** Every manifest of the owning segment; rejects with `UnreadableObjectsError` on a damaged one. */
  readonly list_owner_manifests: () => Promise<readonly M[]>;
}

/**
 * Deletes the newest snapshot of a drive owner or site: its manifest, then the delta cursor.
 * Content blobs stay, because other snapshots reference the same keys.
 *
 * Any other snapshot is refused with `SnapshotNotNewestError`, since newer snapshots fold in the
 * changes it recorded (issue #725).
 *
 * The cursor goes because it points past the deleted run. Without it the next backup reads every
 * drive in full and seeds its version watermarks from the version index. A manifest Object Lock
 * retains is still the newest snapshot, so its cursor stays too.
 *
 * The run's version index (`index/{owner}/runs/{snapshot}.json`) is deliberately kept. Besides one
 * row per manifest entry it holds the historical versions Graph handed over during that run, and
 * the full run that follows would not fetch those again: version capture is skipped for a file
 * whose content is already stored. Deleting the index would make that history unreachable, while
 * keeping it leaves the rows, the watermarks seeded from them and the retained blobs in agreement.
 */
export async function delete_newest_drive_snapshot<M extends OrderedSnapshot>(
  ctx: TenantContext,
  deletion: DriveSnapshotDeletion<M>,
): Promise<DeletionResult> {
  const { workload, label, owner_id, snapshot_id } = deletion;
  const target = await deletion.find_snapshot();
  if (!target) throw new NotFoundError(`No ${label} manifest found for snapshot ${snapshot_id}`);
  await assert_snapshot_is_newest(target, deletion.list_owner_manifests, deletion.wording);
  deletion.lease.assert_held();

  const manifest_result = await delete_snapshot_manifest(
    ctx.storage,
    `${workload}/manifests/${owner_id}/${snapshot_id}.json`,
    label,
    snapshot_id,
  );
  if (has_survivors(manifest_result)) return manifest_result;

  const cursor_result = await delete_scopes(ctx.storage, [
    `${workload}/_meta/${owner_id}/delta.json`,
  ]);
  return merge_deletion_results(manifest_result, cursor_result);
}
