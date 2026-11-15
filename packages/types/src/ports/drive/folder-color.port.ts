import type { DriveFolderColor } from '@/domain/drive/item-metadata';

/**
 * Reads folder colours from each folder's list item. Both `OneDriveConnector` and
 * `SharePointSiteConnector` include it. There is no write: Graph rejects every write to these
 * columns with `403 accessDenied` ("Field '_ColorHex' is read-only"), so restore cannot set them.
 */
export interface DriveFolderColorConnector {
  /**
   * Reads the colour of each folder, batched 20 to a request. A folder without a colour maps to an
   * empty object. A folder missing from the map could not be read; the caller must not treat that
   * as "no colour".
   */
  fetch_folder_colors(
    drive_id: string,
    item_ids: readonly string[],
  ): Promise<Map<string, DriveFolderColor>>;
}

/** What a restore did with folder colours: nothing, because Graph cannot write them. */
export interface DriveFolderColorRestoreSummary {
  /**
   * Selected folders whose captured colour the restore could not apply. Not an error and never
   * part of `errors`: the restored folders take the destination's default colour.
   */
  readonly folder_colors_not_restored?: number | undefined;
}
