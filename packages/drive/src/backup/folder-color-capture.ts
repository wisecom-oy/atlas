import type { DriveFolderColor, DriveFolderColorConnector } from '@wisecom/atlas-types';
import type { DriveDeltaItem } from '@/drive-ports';
import { present_folder_color, same_folder_color } from '@/shared/folder-color';

/** The cursor map the colour capture reads and updates. */
export interface FolderColorTracking {
  folder_color_by_item_id?: Record<string, DriveFolderColor>;
}

/** What a run learned about one folder's colour. */
export type FolderColorObservation =
  | { readonly read: false }
  | {
      readonly read: true;
      /** Undefined when the folder has no colour. */
      readonly color: DriveFolderColor | undefined;
      /** The colour differs from what the cursor last recorded for the folder. */
      readonly changed: boolean;
    };

const NOT_READ: FolderColorObservation = { read: false };

/** The cursor's colour map, created on first use for cursors written before it existed. */
export function folder_colors(tracking: FolderColorTracking): Record<string, DriveFolderColor> {
  tracking.folder_color_by_item_id ??= {};
  return tracking.folder_color_by_item_id;
}

/**
 * Whether a delta item's colour is worth reading: a live folder other than the drive root. A colour
 * change brings the folder back in delta (its eTag moves) but delta never carries the colour, so
 * every folder delta returns is read.
 */
export function is_folder_color_candidate(item: DriveDeltaItem): boolean {
  return item.kind === 'folder' && !item.deleted && item.is_root !== true;
}

/**
 * Reads and remembers folder colours for one backup run. Folders are read in `$batch` requests
 * ahead of processing; one that was not read ahead is read on its own.
 */
export class DriveFolderColorCapture {
  private readonly _fetched = new Map<string, DriveFolderColor>();
  /** Folders already asked for, read or not, so a failed read is not repeated within the run. */
  private readonly _attempted = new Set<string>();

  constructor(private readonly _connector: DriveFolderColorConnector) {}

  /** Reads the colour of every candidate in `items`, 20 folders per Graph request. */
  async prefetch(drive_id: string, items: readonly DriveDeltaItem[]): Promise<void> {
    const ids = items
      .filter((item) => is_folder_color_candidate(item) && !this._attempted.has(item.item_id))
      .map((item) => item.item_id);
    if (ids.length === 0) return;
    for (const id of ids) this._attempted.add(id);
    const fetched = await this._connector.fetch_folder_colors(drive_id, ids);
    for (const [item_id, color] of fetched) this._fetched.set(item_id, color);
  }

  /** What the run knows about the folder's colour, compared with the cursor's record. */
  async observe(
    item: DriveDeltaItem,
    tracking: FolderColorTracking,
  ): Promise<FolderColorObservation> {
    if (!is_folder_color_candidate(item)) return NOT_READ;
    if (!this._attempted.has(item.item_id)) await this.prefetch(item.drive_id, [item]);
    const fetched = this._fetched.get(item.item_id);
    if (fetched === undefined) return NOT_READ;
    const color = present_folder_color(fetched);
    const previous = tracking.folder_color_by_item_id?.[item.item_id];
    return { read: true, color, changed: !same_folder_color(color, previous) };
  }
}
