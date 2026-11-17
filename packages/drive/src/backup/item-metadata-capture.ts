import type { DriveFolderColorConnector, DriveSharingConnector } from '@wisecom/atlas-types';
import type { DriveDeltaItem } from '@/drive-ports';
import { DriveFolderColorCapture } from '@/backup/folder-color-capture';
import { DriveSharingCapture, type PermissionDigestTracking } from '@/backup/sharing-capture';
import { NO_PREVIOUS_ENTRIES, type PreviousEntryLookup } from '@/backup/previous-entry-lookup';

/** The connector calls a run's metadata capture makes. */
export type ItemMetadataConnector = Pick<DriveSharingConnector, 'fetch_item_permissions'> &
  DriveFolderColorConnector;

/**
 * Everything a backup run reads about an item besides its content: permissions for files and
 * folders, and colours for folders. One object per run, so each read happens at most once.
 */
export class DriveItemMetadataCapture {
  constructor(
    readonly sharing: DriveSharingCapture,
    readonly folder_colors: DriveFolderColorCapture,
  ) {}

  /**
   * Reads permissions and folder colours for a batch of delta items ahead of processing them, in
   * `$batch` requests of 20, instead of one request per item inside the processing loop.
   */
  async prefetch(
    drive_id: string,
    items: readonly DriveDeltaItem[],
    tracking: PermissionDigestTracking,
  ): Promise<void> {
    await this.sharing.prefetch(drive_id, items, tracking);
    await this.folder_colors.prefetch(drive_id, items);
  }
}

/** The run's metadata capture over one connector. */
export function create_item_metadata_capture(
  connector: ItemMetadataConnector,
  find_previous: PreviousEntryLookup = NO_PREVIOUS_ENTRIES,
): DriveItemMetadataCapture {
  return new DriveItemMetadataCapture(
    new DriveSharingCapture(connector, find_previous),
    new DriveFolderColorCapture(connector),
  );
}
