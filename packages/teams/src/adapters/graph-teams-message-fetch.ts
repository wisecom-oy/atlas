import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  TeamsGraphResource,
  TeamsMessageDeltaPage,
  TeamsMessageListPage,
  TeamsRootChange,
  TeamsRootFetchResult,
} from '@wisecom/atlas-types';
import {
  graph_teams_call,
  INCLUDE_UNKNOWN_ENUM_HEADERS,
  INCLUDE_UNKNOWN_ENUM_PREFER,
  read_collection_page,
} from '@/adapters/graph-teams-request';
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

/** First delta page URL of a channel: every change Graph still holds. */
function delta_start_url(team_id: string, channel_id: string): string {
  return `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages/delta?${ROOT_QUERY}`;
}

/** First `/messages` page URL of a channel. */
function list_start_url(team_id: string, channel_id: string): string {
  return `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages?${ROOT_QUERY}`;
}

/**
 * Reads one page of a channel's message delta feed. `url` undefined starts the feed; a page
 * without a next link must carry the delta link, or Graph has ended the read without one.
 */
export async function fetch_message_delta_page(
  client: Client,
  team_id: string,
  channel_id: string,
  url: string | undefined,
): Promise<TeamsMessageDeltaPage> {
  const page = await read_collection_page<GraphChannelMessage>(
    client,
    url ?? delta_start_url(team_id, channel_id),
    INCLUDE_UNKNOWN_ENUM_HEADERS,
  );
  const next_link = page['@odata.nextLink'];
  const delta_link = page['@odata.deltaLink'];
  if (next_link === undefined && delta_link === undefined) {
    throw new Error(`Graph ended the message delta of channel ${channel_id} without a delta link`);
  }
  return { roots: (page.value ?? []).map(to_root_change), next_link, delta_link };
}

/** Reads one page of a channel's `/messages`, for channels delta cannot serve or a full read. */
export async function list_channel_messages_page(
  client: Client,
  team_id: string,
  channel_id: string,
  url: string | undefined,
): Promise<TeamsMessageListPage> {
  const page = await read_collection_page<GraphChannelMessage>(
    client,
    url ?? list_start_url(team_id, channel_id),
    INCLUDE_UNKNOWN_ENUM_HEADERS,
  );
  return { roots: (page.value ?? []).map(to_root_change), next_link: page['@odata.nextLink'] };
}

/**
 * Reads one root message without its replies; callers list replies separately. Resolves
 * `not_found` on a 404 so the caller can count the miss without treating the root as removed.
 */
export async function get_channel_message(
  client: Client,
  team_id: string,
  channel_id: string,
  root_id: string,
): Promise<TeamsRootFetchResult> {
  const url = `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages/${encodeURIComponent(root_id)}`;
  try {
    const message = await graph_teams_call(
      () =>
        client
          .api(url)
          .header('Prefer', INCLUDE_UNKNOWN_ENUM_PREFER)
          .get() as Promise<GraphChannelMessage>,
    );
    return { status: 'found', change: to_root_change(message) };
  } catch (err) {
    if (graph_status_of(err) === 404) return { status: 'not_found' };
    throw err;
  }
}
