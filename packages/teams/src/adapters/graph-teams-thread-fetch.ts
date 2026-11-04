import type { Client } from '@microsoft/microsoft-graph-client';
import { GraphError, ResponseType } from '@microsoft/microsoft-graph-client';
import type {
  TeamsGraphResource,
  TeamsHostedContent,
  TeamsMessageLocator,
} from '@wisecom/atlas-types';
import {
  graph_teams_call,
  INCLUDE_UNKNOWN_ENUM_HEADERS,
  read_all_pages,
} from '@/adapters/graph-teams-request';

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

/** The raw `$value` response: status, bytes and the headers Graph sent with them. */
interface RawHostedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

/**
 * Downloads one hosted content item's raw bytes and its Content-Type header. A raw response is
 * not checked by the Graph client, so a non-2xx is turned into a GraphError here, inside the
 * retried call: otherwise a 404 or 429 error body would be stored as the image.
 */
export async function download_hosted_content(
  client: Client,
  locator: TeamsMessageLocator,
  hosted_id: string,
): Promise<TeamsHostedContent> {
  const url = `${hosted_contents_path(locator)}/${encodeURIComponent(hosted_id)}/$value`;
  const response = await graph_teams_call(async () => {
    const raw = (await client.api(url).responseType(ResponseType.RAW).get()) as RawHostedResponse;
    if (!raw.ok) throw await graph_error_from(raw);
    return raw;
  });
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    content_type: response.headers.get('content-type') ?? undefined,
  };
}

/**
 * Builds the GraphError the client would have thrown for a non-raw request: status, Graph error
 * code, body, and headers, so retry, Retry-After, 403 and 404 handling all see the usual shape.
 */
async function graph_error_from(raw: RawHostedResponse): Promise<GraphError> {
  const body = (await raw.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  const error = new GraphError(raw.status, body?.error?.message ?? `HTTP ${raw.status}`);
  error.code = body?.error?.code ?? null;
  error.body = body;
  error.headers = raw.headers as unknown as Headers;
  return error;
}
