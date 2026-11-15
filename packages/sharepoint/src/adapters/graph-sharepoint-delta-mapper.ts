/**
 * The SharePoint name for the shared drive item mapper. The delta select fields, the Graph item
 * shape and the mapping itself live in `@wisecom/atlas-drive`, where OneDrive reads the same ones:
 * the two copies had already drifted once.
 */
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import { map_drive_delta_item } from '@wisecom/atlas-drive/graph/drive-delta-item-mapper';
import type { IdentifiedGraphDeltaDriveItem } from '@wisecom/atlas-drive/graph/graph-drive-item';

export {
  extract_parent_path,
  has_item_id,
  normalize_path,
} from '@wisecom/atlas-drive/graph/drive-delta-item-mapper';
export type {
  GraphDeltaDriveItem,
  IdentifiedGraphDeltaDriveItem,
} from '@wisecom/atlas-drive/graph/graph-drive-item';

/** Maps a raw Graph drive delta item to the domain SharePointDeltaItem model. */
export function map_delta_item(
  raw: IdentifiedGraphDeltaDriveItem,
  drive_id: string,
): SharePointDeltaItem {
  return map_drive_delta_item(raw, drive_id);
}
