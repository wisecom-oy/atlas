import type { GraphApiClient } from '@/permissions/graph-api-client';
import type {
  DriveAccessGrantRequest,
  DriveLinkRequest,
  DriveRecipient,
  DriveSharingWriteOutcome,
} from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { refusal_from_error } from '@/permissions/graph-sharing-refusal';

/** Graph `driveRecipient`: an object id when known, else an address. */
function to_drive_recipient(recipient: DriveRecipient): Record<string, string> {
  if (recipient.object_id) return { objectId: recipient.object_id };
  return recipient.email ? { email: recipient.email } : {};
}

/**
 * Grants direct access through `POST /invite` with `sendInvitation: false` and
 * `requireSignIn: true`: the grantee gets the role back without an email announcing it, and only
 * as a signed-in identity. Repeating the call for a grant that exists changes nothing, so it is
 * retried like a read.
 */
export async function graph_grant_item_access(
  client: GraphApiClient,
  drive_id: string,
  item_id: string,
  request: DriveAccessGrantRequest,
): Promise<DriveSharingWriteOutcome> {
  try {
    await with_graph_retry(() =>
      client.api(`/drives/${drive_id}/items/${item_id}/invite`).post({
        recipients: [to_drive_recipient(request.recipient)],
        roles: [...request.roles],
        sendInvitation: false,
        requireSignIn: true,
      }),
    );
    return { status: 'applied' };
  } catch (err) {
    return refusal_from_error(err);
  }
}

/**
 * Creates a sharing link through `POST /createLink`. Graph answers a request for a link that
 * already exists with that link, so a retry never creates a second one. The response carries the
 * new link's URL; it is discarded unread.
 */
export async function graph_create_item_link(
  client: GraphApiClient,
  drive_id: string,
  item_id: string,
  request: DriveLinkRequest,
): Promise<DriveSharingWriteOutcome> {
  const recipients = (request.recipients ?? []).map(to_drive_recipient);
  try {
    await with_graph_retry(() =>
      client.api(`/drives/${drive_id}/items/${item_id}/createLink`).post({
        type: request.type,
        scope: request.scope,
        ...(request.expires_at ? { expirationDateTime: request.expires_at } : {}),
        ...(recipients.length > 0 ? { recipients } : {}),
      }),
    );
    return { status: 'applied' };
  } catch (err) {
    return refusal_from_error(err);
  }
}
