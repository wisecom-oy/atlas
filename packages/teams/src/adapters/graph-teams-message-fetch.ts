import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  TeamsGraphResource,
  TeamsMessageDeltaResult,
  TeamsRootChange,
} from '@wisecom/atlas-types';
import { graph_teams_call, read_all_pages } from '@/adapters/graph-teams-request';
import { graph_status_of } from '@/services/shared/graph-error-status';

/** A channel message as Graph returns it from `/messages` or `/messages/delta`. */
type GraphChannelMessage = TeamsGraphResource & {
  readonly '@removed'?: unknown;
  readonly deletedDateTime?: string | null;
  readonly replies?: TeamsGraphResource[];
  readonly 'replies@odata.nextLink'?: string;
};

/** Page size and inline replies for every root read. Verified live on both endpoints. */
const ROOT_QUERY = '$top=50&$expand=replies';

/** Keys a stored root must not carry: replies are stored in their own blob. */
const NON_ROOT_KEYS: Record<string, true> = {
  replies: true,
  'replies@odata.nextLink': true,
  '@removed': true,
};

/**
 * Turns a Graph message into a root change. `replies` is inlined only when Graph returned the
 * complete list (no `replies@odata.nextLink`); otherwise the caller pages `/replies`.
 */
function to_root_change(message: GraphChannelMessage): TeamsRootChange {
  const deleted = message['@removed'] !== undefined || typeof message.deletedDateTime === 'string';
  const replies_complete =
    Array.isArray(message.replies) && message['replies@odata.nextLink'] === undefined;
  const root = Object.fromEntries(
    Object.entries(message).filter(([key]) => NON_ROOT_KEYS[key] !== true),
  ) as TeamsGraphResource;
  return { root, deleted, replies: replies_complete ? message.replies : undefined };
}

/**
 * Reads a channel's root message changes since `prev_delta_link`, or every root when it is
 * undefined. Throws when Graph ends the read without a delta link.
 */
export async function fetch_message_delta(
  client: Client,
  team_id: string,
  channel_id: string,
  prev_delta_link: string | undefined,
): Promise<TeamsMessageDeltaResult> {
  const start =
    prev_delta_link ??
    `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages/delta?${ROOT_QUERY}`;
  const { items, delta_link } = await read_all_pages<GraphChannelMessage>(client, start);
  if (delta_link === undefined) {
    throw new Error(`Graph ended the message delta of channel ${channel_id} without a delta link`);
  }
  return { roots: items.map(to_root_change), delta_link };
}

/** Reads every root message of a channel with `/messages`, for channels delta cannot serve. */
export async function list_channel_messages(
  client: Client,
  team_id: string,
  channel_id: string,
): Promise<TeamsRootChange[]> {
  const { items } = await read_all_pages<GraphChannelMessage>(
    client,
    `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages?${ROOT_QUERY}`,
  );
  return items.map(to_root_change);
}

/**
 * Reads one root message with its replies inlined. Resolves undefined when Graph no longer has
 * it (404), so the caller can treat the root as removed.
 */
export async function get_channel_message(
  client: Client,
  team_id: string,
  channel_id: string,
  root_id: string,
): Promise<TeamsRootChange | undefined> {
  const url = `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages/${encodeURIComponent(root_id)}?$expand=replies`;
  try {
    const message = await graph_teams_call(
      () => client.api(url).get() as Promise<GraphChannelMessage>,
    );
    return to_root_change(message);
  } catch (err) {
    if (graph_status_of(err) === 404) return undefined;
    throw err;
  }
}
