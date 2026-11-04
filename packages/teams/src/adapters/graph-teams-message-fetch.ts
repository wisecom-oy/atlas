import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  TeamsGraphResource,
  TeamsMessageDeltaResult,
  TeamsRootChange,
} from '@wisecom/atlas-types';
import { read_all_pages } from '@/adapters/graph-teams-request';

/** A channel message as Graph returns it from `/messages` or `/messages/delta`. */
type GraphChannelMessage = TeamsGraphResource & { readonly '@removed'?: unknown };

function to_root_change(message: GraphChannelMessage): TeamsRootChange {
  return { root: message, deleted: message['@removed'] !== undefined };
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
  const start = prev_delta_link ?? `/teams/${team_id}/channels/${channel_id}/messages/delta`;
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
    `/teams/${team_id}/channels/${channel_id}/messages`,
  );
  return items.map(to_root_change);
}
