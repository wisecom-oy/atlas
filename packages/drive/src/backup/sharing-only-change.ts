import type { DriveDeltaItem, DriveManifestEntry } from '@/drive-ports';
import { build_permissions_changed_entry } from '@/backup/item-metadata-entries';
import type { DriveSharingCapture, PermissionObservation } from '@/backup/sharing-capture';
import { is_file_entry } from '@/shared/entry-kind';

/**
 * What to do with a file Graph re-presented without a content change.
 *
 * - `none`: nothing about it changed that a backup records.
 * - `entry`: its sharing changed; the entry reuses the earlier blob.
 * - `download`: its sharing changed but no earlier blob was found, so back it up as an update.
 */
export type SharingOnlyPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'entry'; readonly entry: DriveManifestEntry }
  | { readonly kind: 'download' };

const NONE: SharingOnlyPlan = { kind: 'none' };

/**
 * Plans the backup of a live file whose eTag and location did not change. A sharing change moves
 * neither the eTag nor the cTag, yet Graph re-presents the item in delta, so the permissions read
 * for it are the only sign anything happened.
 */
export async function plan_sharing_only_change(
  item: DriveDeltaItem,
  observation: PermissionObservation,
  sharing: DriveSharingCapture,
): Promise<SharingOnlyPlan> {
  if (!observation.read || !observation.changed) return NONE;
  const previous = await sharing.find_previous_entry(item.item_id);
  if (!is_reusable_content(previous)) return { kind: 'download' };
  return {
    kind: 'entry',
    entry: build_permissions_changed_entry(item, previous, observation.permissions),
  };
}

function is_reusable_content(
  entry: DriveManifestEntry | undefined,
): entry is DriveManifestEntry & { storage_key: string } {
  return (
    entry !== undefined &&
    entry.change_type !== 'deleted' &&
    is_file_entry(entry) &&
    typeof entry.storage_key === 'string'
  );
}
