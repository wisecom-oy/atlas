import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import type { DriveGraphClient } from '@wisecom/atlas-drive/backup/graph-item-content';

/**
 * Whether the app can read the tenant's root site (`GET /sites/root?$select=id`). Every app holding
 * `Sites.Read.All` can, so a site refused with 403 while this succeeds is refused on its own, not
 * for a missing grant (issue #772). Resolves false on 401 or 403, and rejects on any other failure,
 * which says nothing about the grant.
 */
export async function can_read_root_site(client: DriveGraphClient): Promise<boolean> {
  try {
    await with_graph_retry(() => client.api('/sites/root?$select=id').get() as Promise<unknown>);
    return true;
  } catch (err) {
    const status =
      err !== null && typeof err === 'object' && 'statusCode' in err ? err.statusCode : undefined;
    if (status === 401 || status === 403) return false;
    throw err;
  }
}
