import type { Client } from '@microsoft/microsoft-graph-client';
import type { ExtendedProperty } from '@wisecom/atlas-types';
import {
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';

const REACTIONS_PROPERTY_SET = '{41F28F13-83F4-4114-A584-EEDB5A6B0BFF}';

/** The MAPI named properties Exchange stores Outlook reactions in (issue #481). */
const REACTION_PROPERTY_IDS = [
  `String ${REACTIONS_PROPERTY_SET} Name OwnerReactionType`,
  `Binary ${REACTIONS_PROPERTY_SET} Name MapiReactionsBlob`,
  `Binary ${REACTIONS_PROPERTY_SET} Name ReactionsSummary`,
];

const REACTION_EXPAND = `singleValueExtendedProperties($filter=${REACTION_PROPERTY_IDS.map(
  (id) => `id eq '${id}'`,
).join(' or ')})`;

/**
 * Fetches a message's reaction properties with one `GET /messages/{id}`. The delta query rejects
 * this `$expand` with 400, so it cannot ride along on the delta page.
 */
export async function fetch_message_reaction_properties(
  client: Client,
  owner_id: string,
  message_id: string,
  immutable_id_prefer: string,
): Promise<ExtendedProperty[]> {
  try {
    const response = (await with_graph_retry(() =>
      client
        .api(`/users/${owner_id}/messages/${message_id}`)
        .header('Prefer', immutable_id_prefer)
        .select('id')
        .expand(REACTION_EXPAND)
        .get(),
    )) as { singleValueExtendedProperties?: ExtendedProperty[] };
    return (response.singleValueExtendedProperties ?? []).map(({ id, value }) => ({ id, value }));
  } catch (err) {
    rethrow_if_mailbox_not_licensed(err);
    rethrow_if_access_denied(err);
    throw err;
  }
}
