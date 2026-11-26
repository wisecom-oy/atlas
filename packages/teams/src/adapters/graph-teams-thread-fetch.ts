import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  TeamsGraphResource,
  TeamsHostedContent,
  TeamsMessageLocator,
} from '@wisecom/atlas-types';
import { get_graph_binary_with_idle_timeout, with_graph_retry } from '@wisecom/atlas-m365-graph';
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

/** Per-attempt timeout of a hosted-content download, matching an Outlook MIME download. */
const HOSTED_CONTENT_DOWNLOAD_TIMEOUT_MS = 1_800_000;

/**
 * Downloads one hosted content item's raw bytes and its Content-Type header. A non-2xx becomes a
 * GraphError with its headers inside the retried call, so a 404 or 429 error body is never stored
 * as the image. The body is read inside each attempt too, so the attempt timeout, the 60 s idle
 * timeout, a retry on a body cut off mid-stream, and Ctrl+C cover it (issue #877). The attempt gets
 * the same 30 min as an Outlook MIME download, so a large body on a slow link still completes; a
 * body that stops arriving is closed by the idle timeout instead. The call is not wrapped in
 * `graph_teams_call`, so a 403 stays a GraphError for the caller to treat as missing.
 */
export async function download_hosted_content(
  client: Client,
  locator: TeamsMessageLocator,
  hosted_id: string,
): Promise<TeamsHostedContent> {
  const url = `${hosted_contents_path(locator)}/${encodeURIComponent(hosted_id)}/$value`;
  return await with_graph_retry(
    (attempt_signal) => get_graph_binary_with_idle_timeout(client.api(url), attempt_signal),
    { timeout_ms: HOSTED_CONTENT_DOWNLOAD_TIMEOUT_MS },
  );
}
