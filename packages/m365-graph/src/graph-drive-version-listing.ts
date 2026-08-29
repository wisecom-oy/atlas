import type { Client } from '@microsoft/microsoft-graph-client';
import type { DriveItemIdentity } from '@wisecom/atlas-types';
import { with_graph_retry } from '@/graph-error-helpers';
import { map_graph_identity, type GraphIdentitySet } from '@/graph-drive-metadata';

const VERSION_SELECT = 'id,lastModifiedDateTime,size,lastModifiedBy';

interface GraphVersionRecord {
  id?: string;
  lastModifiedDateTime?: string;
  size?: number;
  lastModifiedBy?: GraphIdentitySet;
}

interface GraphVersionPage {
  value?: GraphVersionRecord[];
  '@odata.nextLink'?: string;
}

/**
 * One historical version of a drive item.
 *
 * Structurally identical to `OneDriveFileVersion` and `SharePointFileVersion`,
 * which is why this listing is shared: both workloads read the same
 * `/drives/{drive}/items/{item}/versions` collection.
 */
export interface DriveItemVersionRecord {
  readonly version_id: string;
  readonly last_modified_at: string;
  readonly size_bytes: number;
  readonly last_modified_by?: DriveItemIdentity;
}

/**
 * Lists a drive item's historical versions, following pagination.
 *
 * The current version is dropped: Graph returns it first in the collection,
 * and it is the item the manifest already records, so keeping it would store
 * every file's live bytes twice. A single-entry collection therefore yields
 * nothing.
 */
export async function list_drive_item_versions(
  client: Client,
  drive_id: string,
  item_id: string,
): Promise<DriveItemVersionRecord[]> {
  const all_versions: DriveItemVersionRecord[] = [];

  let page = await with_graph_retry(
    () =>
      client
        .api(`/drives/${drive_id}/items/${item_id}/versions`)
        .select(VERSION_SELECT)
        .get() as Promise<GraphVersionPage>,
  );

  while (true) {
    for (const raw of page.value ?? []) {
      if (!raw.id) continue;
      const identity = map_graph_identity(raw.lastModifiedBy);
      all_versions.push({
        version_id: raw.id,
        last_modified_at: raw.lastModifiedDateTime ?? '',
        size_bytes: raw.size ?? 0,
        ...(identity ? { last_modified_by: identity } : {}),
      });
    }

    const next_url = page['@odata.nextLink'];
    if (!next_url) break;
    page = await with_graph_retry(() => client.api(next_url).get() as Promise<GraphVersionPage>);
  }

  if (all_versions.length <= 1) return [];
  return all_versions.slice(1);
}
