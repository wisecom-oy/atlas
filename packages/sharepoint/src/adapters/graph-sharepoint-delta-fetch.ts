import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { SharePointDeltaItem, SharePointDeltaResult } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  DRIVE_DELTA_PREFER,
  DRIVE_DELTA_SELECT_FIELDS,
} from '@wisecom/atlas-drive/graph/graph-drive-item';
import { plan_delta_start } from '@wisecom/atlas-drive/graph/saved-delta-link';
import { final_delta_link } from '@wisecom/atlas-drive/backup/delta-listing-end';
import {
  has_item_id,
  map_delta_item,
  type GraphDeltaDriveItem,
} from '@/adapters/graph-sharepoint-delta-mapper';

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface InitialDeltaPageResult {
  page: GraphCollectionResponse<GraphDeltaDriveItem>;
  /** The saved link predates the `package` facet; tracking is reset. */
  reset_detected: boolean;
  /** The saved link predates the `shared` facet; the library is enumerated afresh. */
  full_enumeration: boolean;
}

/**
 * Fetches the first delta page: the saved link when it is current, else a fresh enumeration.
 * Every delta request carries `Prefer: hierarchicalsharing`, which is what makes the `shared`
 * facet mark only the items whose own sharing changed.
 */
export async function fetch_initial_delta_page(
  client: Client,
  drive_id: string,
  prev_delta_link: string | undefined,
): Promise<InitialDeltaPageResult> {
  const plan = plan_delta_start(prev_delta_link);
  if (plan.reset_detected) {
    logger.warn('Saved delta cursor predates package-facet selection: performing fresh delta');
  } else if (plan.full_enumeration) {
    logger.warn(
      'Saved delta cursor predates sharing capture: enumerating the library once more; ' +
        'unchanged files are not downloaded again',
    );
  }

  const resume_link = plan.resume_link;
  const page = await with_graph_retry(
    () =>
      (resume_link
        ? client.api(resume_link)
        : client.api(`/drives/${drive_id}/root/delta`).select(DRIVE_DELTA_SELECT_FIELDS)
      )
        .header('Prefer', DRIVE_DELTA_PREFER)
        .get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
  );

  return { page, reset_detected: plan.reset_detected, full_enumeration: plan.full_enumeration };
}

/**
 * Pages one library's delta to its end and maps every item. `reset_detected` is set by the caller
 * when Graph rejected the saved link and this is the fresh enumeration that replaces it. Throws
 * when the last page carries no `@odata.deltaLink`, because the listing then stopped early.
 */
export async function execute_sharepoint_delta(
  client: Client,
  drive_id: string,
  prev_delta_link: string | undefined,
  reset_detected: boolean,
): Promise<SharePointDeltaResult> {
  const items: SharePointDeltaItem[] = [];
  let delta_link = '';
  const initial = await fetch_initial_delta_page(client, drive_id, prev_delta_link);
  let page = initial.page;

  let items_without_id = 0;
  while (true) {
    for (const raw of page.value ?? []) {
      if (has_item_id(raw)) items.push(map_delta_item(raw, drive_id));
      else items_without_id++;
    }

    const next = page['@odata.nextLink'];
    if (!next) {
      delta_link = final_delta_link(page, `library ${drive_id}`);
      break;
    }
    page = await with_graph_retry(
      () =>
        client.api(next).header('Prefer', DRIVE_DELTA_PREFER).get() as Promise<
          GraphCollectionResponse<GraphDeltaDriveItem>
        >,
    );
  }
  if (items_without_id > 0) {
    logger.warn(
      `Skipped ${items_without_id} item(s) in drive ${drive_id} that Graph returned without an id`,
    );
  }

  return {
    drive_id,
    delta_link,
    items,
    reset_detected: reset_detected || initial.reset_detected,
    ...(initial.full_enumeration && !reset_detected ? { full_enumeration: true } : {}),
  };
}

/**
 * Fetches one drive item by id with the same field selection as the delta call,
 * so a retried item maps identically to one delivered by delta.
 * Resolves undefined when Graph answers "not found", which the caller does not
 * take as proof of deletion on its own (issue #850).
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
