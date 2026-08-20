import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { GraphDeltaDriveItem } from '@/adapters/graph-sharepoint-delta-mapper';

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

const DRIVE_DELTA_SELECT_FIELDS = [
  'id',
  'name',
  'size',
  'webUrl',
  'eTag',
  'lastModifiedDateTime',
  'parentReference',
  'file',
  'folder',
  'package',
  'deleted',
  '@microsoft.graph.downloadUrl',
].join(',');

export interface InitialDeltaPageResult {
  page: GraphCollectionResponse<GraphDeltaDriveItem>;
  reset_detected: boolean;
}

/** Fetches the first delta page, resetting when the stored cursor predates field selection. */
export async function fetch_initial_delta_page(
  client: Client,
  drive_id: string,
  prev_delta_link: string | undefined,
): Promise<InitialDeltaPageResult> {
  const stale_cursor = prev_delta_link && !prev_delta_link.includes('package');
  if (stale_cursor) {
    logger.warn(
      `Delta cursor for drive ${drive_id} predates package-facet selection — performing fresh delta`,
    );
  }

  const page =
    prev_delta_link && !stale_cursor
      ? await with_graph_retry(
          () =>
            client.api(prev_delta_link).get() as Promise<
              GraphCollectionResponse<GraphDeltaDriveItem>
            >,
        )
      : await with_graph_retry(
          () =>
            client
              .api(`/drives/${drive_id}/root/delta`)
              .select(DRIVE_DELTA_SELECT_FIELDS)
              .get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
        );

  return { page, reset_detected: Boolean(stale_cursor) };
}

/**
 * Fetches one drive item by id with the same field selection as the delta call,
 * so a retried item maps identically to one delivered by delta.
 * Resolves undefined when Graph reports the item no longer exists.
 */
export async function fetch_drive_item_by_id(
  client: Client,
  drive_id: string,
  item_id: string,
): Promise<GraphDeltaDriveItem | undefined> {
  try {
    return await with_graph_retry(
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
}

/** True when Graph reports the requested drive item does not exist. */
function is_item_not_found(err: unknown): boolean {
  const graph_err = err as Record<string, unknown> | null;
  if (!graph_err) return false;
  return graph_err.statusCode === 404 || graph_err.code === 'itemNotFound';
}

export type { GraphCollectionResponse };
