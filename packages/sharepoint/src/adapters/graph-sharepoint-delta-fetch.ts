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
  const stale_cursor = prev_delta_link && !prev_delta_link.includes('$select=');
  if (stale_cursor) {
    logger.warn(
      `Delta cursor for drive ${drive_id} predates field selection — performing fresh delta`,
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

export type { GraphCollectionResponse };
