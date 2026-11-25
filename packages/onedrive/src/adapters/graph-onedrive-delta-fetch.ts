import type { Client } from '@microsoft/microsoft-graph-client';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { OneDriveDeltaItem, OneDriveDeltaResult } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { plan_delta_start, type DeltaStartPlan } from '@wisecom/atlas-drive/graph/saved-delta-link';
import { final_delta_link } from '@wisecom/atlas-drive/backup/delta-listing-end';
import {
  DRIVE_DELTA_PREFER,
  DRIVE_DELTA_SELECT_FIELDS,
  has_item_id,
  map_delta_item,
  type GraphDeltaDriveItem,
} from '@/adapters/graph-onedrive-delta-mapper';

interface GraphCollectionResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/**
 * Fetches the first delta page: the saved link when it is current, else a fresh enumeration.
 * Every delta request carries `Prefer: hierarchicalsharing`, which is what makes the `shared`
 * facet mark only the items whose own sharing changed.
 */
async function fetch_initial_delta_page(
  client: Client,
  owner_id: string,
  drive_id: string,
  prev_delta_link: string | undefined,
): Promise<{ page: GraphCollectionResponse<GraphDeltaDriveItem>; plan: DeltaStartPlan }> {
  const plan = plan_delta_start(prev_delta_link);
  if (plan.reset_detected) {
    logger.warn('Saved delta cursor predates package-facet selection: performing fresh delta');
  } else if (plan.full_enumeration) {
    logger.warn(
      'Saved delta cursor predates sharing capture: enumerating the drive once more; ' +
        'unchanged files are not downloaded again',
    );
  }

  const resume_link = plan.resume_link;
  const page = await with_graph_retry(
    () =>
      (resume_link
        ? client.api(resume_link)
        : client
            .api(`/users/${owner_id}/drives/${drive_id}/root/delta`)
            .select(DRIVE_DELTA_SELECT_FIELDS)
      )
        .header('Prefer', DRIVE_DELTA_PREFER)
        .get() as Promise<GraphCollectionResponse<GraphDeltaDriveItem>>,
  );
  return { page, plan };
}

/**
 * Pages one drive's delta to its end and maps every item. `reset_detected` is set by the caller
 * when Graph rejected the saved link and this is the fresh enumeration that replaces it. Throws
 * when the last page carries no `@odata.deltaLink`, because the listing then stopped early.
 */
export async function execute_onedrive_delta(
  client: Client,
  owner_id: string,
  drive_id: string,
  prev_delta_link: string | undefined,
  reset_detected: boolean,
): Promise<OneDriveDeltaResult> {
  const items: OneDriveDeltaItem[] = [];
  let delta_link = '';
  const { page: initial_page, plan } = await fetch_initial_delta_page(
    client,
    owner_id,
    drive_id,
    prev_delta_link,
  );
  let page = initial_page;

  let items_without_id = 0;
  while (true) {
    for (const raw of page.value ?? []) {
      if (has_item_id(raw)) items.push(map_delta_item(raw, drive_id));
      else items_without_id++;
    }

    const next = page['@odata.nextLink'];
    if (!next) {
      delta_link = final_delta_link(page, `drive ${drive_id}`);
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
    reset_detected: reset_detected || plan.reset_detected,
    ...(plan.full_enumeration && !reset_detected ? { full_enumeration: true } : {}),
  };
}
