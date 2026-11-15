/**
 * The OneDrive name for the shared drive item mapper. The delta select fields, the Graph item shape
 * and the mapping itself live in `@wisecom/atlas-drive`, where SharePoint reads the same ones: the
 * two copies had already drifted once.
 */
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import { map_drive_delta_item } from '@wisecom/atlas-drive/graph/drive-delta-item-mapper';
import type { IdentifiedGraphDeltaDriveItem } from '@wisecom/atlas-drive/graph/graph-drive-item';

export { has_item_id } from '@wisecom/atlas-drive/graph/drive-delta-item-mapper';
export {
  DRIVE_DELTA_PREFER,
  DRIVE_DELTA_SELECT_FIELDS,
  type GraphDeltaDriveItem,
  type IdentifiedGraphDeltaDriveItem,
} from '@wisecom/atlas-drive/graph/graph-drive-item';

/** Maps a raw Graph delta drive item to the domain delta item. */
export function map_delta_item(
  raw: IdentifiedGraphDeltaDriveItem,
  drive_id: string,
): OneDriveDeltaItem {
  return map_drive_delta_item(raw, drive_id);
}
