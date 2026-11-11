import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  TeamsGraphResource,
  TeamsHostedContent,
  TeamsMessageLocator,
} from '@wisecom/atlas-types';
import { get_graph_binary_response, with_graph_retry } from '@wisecom/atlas-m365-graph';
import { INCLUDE_UNKNOWN_ENUM_HEADERS, read_all_pages } from '@/adapters/graph-teams-request';

function message_path(team_id: string, channel_id: string, root_id: string): string {
  return `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages/${encodeURIComponent(root_id)}`;
}

function hosted_contents_path(locator: TeamsMessageLocator): string {
  const root = message_path(locator.team_id, locator.channel_id, locator.root_id);
  return locator.reply_id === undefined
    ? `${root}/hostedContents`
    : `${root}/replies/${encodeURIComponent(locator.reply_id)}/hostedContents`;
}

/** Lists every reply of a root message, deleted replies included. */
export async function list_replies(
  client: Client,
  team_id: string,
  channel_id: string,
  root_id: string,
): Promise<TeamsGraphResource[]> {
  const { items } = await read_all_pages<TeamsGraphResource>(
    client,
    `${message_path(team_id, channel_id, root_id)}/replies?$top=50`,
    INCLUDE_UNKNOWN_ENUM_HEADERS,
  );
  return items;
}

/** Lists the `hostedContents` of a root message, or of a reply when the locator names one. */
export async function list_hosted_contents(
  client: Client,
  locator: TeamsMessageLocator,
): Promise<TeamsGraphResource[]> {
  const { items } = await read_all_pages<TeamsGraphResource>(client, hosted_contents_path(locator));
  return items;
}

/**
 * Downloads one hosted content item's raw bytes and its Content-Type header. A non-2xx becomes a
 * GraphError with its headers inside the retried call, so a 404 or 429 error body is never stored
 * as the image. The call is not wrapped in `graph_teams_call`, so a 403 stays a GraphError for the
 * caller to treat as missing.
 */
export async function download_hosted_content(
  client: Client,
  locator: TeamsMessageLocator,
  hosted_id: string,
): Promise<TeamsHostedContent> {
  const url = `${hosted_contents_path(locator)}/${encodeURIComponent(hosted_id)}/$value`;
  const response = await with_graph_retry(() => get_graph_binary_response(client.api(url)));
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    content_type: response.headers.get('content-type') ?? undefined,
  };
}
