import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import {
  DRIVE_DELTA_SELECT_FIELDS,
  map_delta_item,
  type GraphDeltaDriveItem,
} from '@/adapters/graph-onedrive-delta-mapper';

/** Graph reports an item that no longer exists as HTTP 404 / `itemNotFound`. */
function is_item_not_found(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const graph_err = err as Record<string, unknown>;
  return graph_err.statusCode === 404 || graph_err.code === 'itemNotFound';
}

/**
 * Reads one drive item directly, for retrying an item that delta will never
 * re-present because it has not changed since it failed.
 *
 * Resolves undefined only for a genuine "gone" answer. Every other Graph error
 * propagates: mistaking a throttle or an outage for a deletion would silently
 * drop the item from the failure ledger and lose the file for good.
 */
export async function graph_onedrive_fetch_item_by_id(
  client: Client,
  drive_id: string,
  item_id: string,
): Promise<OneDriveDeltaItem | undefined> {
  let raw: GraphDeltaDriveItem;
  try {
    raw = await with_graph_retry(
      () =>
        client
          .api(`/drives/${drive_id}/items/${item_id}`)
          .select(DRIVE_DELTA_SELECT_FIELDS)
          .get() as Promise<GraphDeltaDriveItem>,
    );
  } catch (err) {
    if (is_item_not_found(err)) return undefined;
    throw err;
  }
  return raw.id ? map_delta_item(raw, drive_id) : undefined;
}
