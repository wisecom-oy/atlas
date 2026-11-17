import type { GraphApiClient } from '@/permissions/graph-api-client';
import type { DrivePermission } from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import { batch_read_each } from '@/graph/graph-batch-read';
import { sanitize_graph_permissions } from '@/permissions/permission-sanitizer';

interface PermissionPage {
  readonly value?: unknown[];
  readonly '@odata.nextLink'?: string;
}

/**
 * Reads the non-inherited permissions of each item, 20 items to a `$batch` round trip rather than
 * one `GET /permissions` each, which on a large drive would let permission reads dominate the
 * Graph budget.
 *
 * An item missing from the result could not be read: it was deleted meanwhile, or Graph refused it.
 * The reason is logged, and the caller treats the item as "not read", never as "no permissions".
 */
export async function fetch_drive_item_permissions(
  client: GraphApiClient,
  drive_id: string,
  item_ids: readonly string[],
): Promise<Map<string, DrivePermission[]>> {
  const requests = item_ids.map((item_id) => ({
    key: item_id,
    url: `/drives/${drive_id}/items/${item_id}/permissions`,
  }));
  return batch_read_each(client, requests, {
    label: 'Permission capture',
    read_body: (body) => read_all_pages(client, body as PermissionPage),
  });
}

/** Follows `@odata.nextLink` on the rare item whose permission list spans pages. */
async function read_all_pages(
  client: GraphApiClient,
  first: PermissionPage,
): Promise<DrivePermission[]> {
  const raw: unknown[] = [...(first.value ?? [])];
  let next = first['@odata.nextLink'];
  while (next) {
    const url = next;
    const page = await with_graph_retry(() => client.api(url).get() as Promise<PermissionPage>);
    append_all(raw, page.value ?? []);
    next = page['@odata.nextLink'];
  }
  return sanitize_graph_permissions(raw);
}
