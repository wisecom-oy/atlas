import type { GraphApiClient } from '@/permissions/graph-api-client';
import type { DriveSharingConnector } from '@wisecom/atlas-types';
import { fetch_drive_item_permissions } from '@/permissions/graph-permission-fetch';
import {
  graph_create_item_link,
  graph_grant_item_access,
} from '@/permissions/graph-sharing-writes';

/**
 * The sharing calls both drive connectors expose. Addressed by drive id rather than by owner or
 * site, so OneDrive and SharePoint send identical requests.
 */
export function create_graph_drive_sharing(client: GraphApiClient): DriveSharingConnector {
  return {
    fetch_item_permissions: (drive_id, item_ids) =>
      fetch_drive_item_permissions(client, drive_id, item_ids),
    grant_item_access: (drive_id, item_id, request) =>
      graph_grant_item_access(client, drive_id, item_id, request),
    create_item_link: (drive_id, item_id, request) =>
      graph_create_item_link(client, drive_id, item_id, request),
  };
}
