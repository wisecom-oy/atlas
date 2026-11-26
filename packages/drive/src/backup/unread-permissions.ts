/**
 * What a backup run does with an item whose permissions it asked Microsoft Graph for and did not
 * get (issue #856).
 *
 * Delta never re-presents an unchanged item, so a sharing change whose read failed is lost unless
 * the run records it. The item goes on the failed-items list, which already re-reads an item by id
 * at the start of the next run, keeps a "not found" answer until the deletion is confirmed (issue
 * #850), and holds the run unhealthy until the list is empty. A file whose content changed is still
 * stored, and its entry keeps the grants of the newest earlier entry rather than losing them.
 */

import {
  record_item_failure,
  type FailedItemLedger,
  type FailedItemRecord,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveDeltaItem } from '@/drive-ports';
import type { DriveSharingCapture, PermissionObservation } from '@/backup/sharing-capture';
import { digest_permissions } from '@/permissions/permission-digest';

/** The failed-items reason for an item whose permissions could not be read. */
export const PERMISSION_READ_FAILURE_REASON =
  'Permission read failed: Microsoft Graph did not return the sharing permissions';

/**
 * The observation a stored file entry is built from. When the read of the file's permissions
 * failed, it is the permissions of the file's newest earlier entry, as if read, so the entry and the
 * cursor digest keep the last known grants. An earlier entry that cannot be found carries none, and
 * the digest is cleared to match, so the next read records whatever grants the file has. Any other
 * observation is returned as it is.
 */
export async function carry_forward_unread_permissions(
  item_id: string,
  observation: PermissionObservation,
  sharing: DriveSharingCapture,
): Promise<PermissionObservation> {
  if (observation.read || !observation.failed) return observation;
  const previous = await sharing.find_previous_entry(item_id);
  const permissions = previous?.change_type === 'deleted' ? [] : (previous?.permissions ?? []);
  return { read: true, permissions, digest: digest_permissions(permissions), changed: false };
}

/**
 * Logs the failed permission read and records it on the failed-items list, spending one of the
 * item's attempts. A Graph outage never gets here, since it stops the run first (issue #881), so
 * what remains is a refusal of this item's read, such as a `404` or a `423`.
 */
export function record_permission_read_failure(
  ledger: FailedItemLedger,
  drive_id: string,
  item: Pick<DriveDeltaItem, 'item_id' | 'file_name'>,
): FailedItemLedger {
  logger.warn(
    `Drive ${drive_id}: ${PERMISSION_READ_FAILURE_REASON} for ${item.file_name} (${item.item_id}); ` +
      'recorded for retry',
  );
  return record_item_failure(ledger, {
    item_id: item.item_id,
    drive_id,
    name: item.file_name,
    reason: PERMISSION_READ_FAILURE_REASON,
  });
}

/**
 * Whether the item's latest failure was its permission read. Such an item's content was stored in
 * the run that recorded it, so its tracking is current and a retry need not download it again.
 */
export function is_permission_read_failure(record: FailedItemRecord): boolean {
  return record.reason === PERMISSION_READ_FAILURE_REASON;
}
