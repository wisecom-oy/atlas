import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN, with_graph_retry } from '@wisecom/atlas-m365-graph';
import type {
  TeamsConnector,
  TeamsFilesFolderRef,
  TeamsGraphResource,
  TeamsHostedContent,
  TeamsMessageDeltaPage,
  TeamsMessageListPage,
  TeamsMessageLocator,
  TeamsRootFetchResult,
} from '@wisecom/atlas-types';
import { graph_teams_call, read_all_pages } from '@/adapters/graph-teams-request';
import { graph_status_of } from '@/services/shared/graph-error-status';
import {
  fetch_message_delta_page,
  get_channel_message,
  list_channel_messages_page,
} from '@/adapters/graph-teams-message-fetch';
import {
  download_hosted_content,
  list_hosted_contents,
  list_replies,
} from '@/adapters/graph-teams-thread-fetch';

/** The Files folder shape Graph returns for `/channels/{id}/filesFolder`. */
interface GraphFilesFolder {
  readonly id?: string;
  readonly webUrl?: string;
  readonly parentReference?: { readonly driveId?: string };
}

/** Reads Teams, channels, and channel messages through the tenant-scoped Graph client. */
@injectable()
export class GraphTeamsConnector implements TeamsConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Lists every team in the tenant. The tenant is implicit in the app-only Graph client. */
  async list_teams(_tenant_id: string): Promise<TeamsGraphResource[]> {
    // `/teams` needs only Team.ReadBasic.All; the `/groups` filter would need Group.Read.All.
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      '/teams?$select=id,displayName',
    );
    return items;
  }

  /** Fetches one team with its settings. */
  async get_team(_tenant_id: string, team_id: string): Promise<TeamsGraphResource> {
    return graph_teams_call(
      () =>
        this._client
          .api(`/teams/${encodeURIComponent(team_id)}`)
          .get() as Promise<TeamsGraphResource>,
    );
  }

  /** Lists the team's members. */
  async list_team_members(_tenant_id: string, team_id: string): Promise<TeamsGraphResource[]> {
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      `/teams/${encodeURIComponent(team_id)}/members?$top=999`,
    );
    return items;
  }

  /** Lists the team's channels. */
  async list_channels(_tenant_id: string, team_id: string): Promise<TeamsGraphResource[]> {
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      `/teams/${encodeURIComponent(team_id)}/channels`,
    );
    return items;
  }

  /** Lists a channel's members. */
  async list_channel_members(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsGraphResource[]> {
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/members?$top=999`,
    );
    return items;
  }

  /** Lists a channel's tabs with the backing app expanded. */
  async list_channel_tabs(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsGraphResource[]> {
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/tabs?$expand=teamsApp`,
    );
    return items;
  }

  /** Lists the teams a shared channel is shared with. */
  async list_channel_shared_teams(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsGraphResource[]> {
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/sharedWithTeams`,
    );
    return items;
  }

  /**
   * Resolves the channel's Files folder to its SharePoint drive item. Resolves undefined when
   * Graph has no folder for the channel (404), and `unavailable` when the app is refused it (403).
   * Calls `with_graph_retry` directly, not `graph_teams_call`, so a 403 is a per-channel gap and
   * does not fail the run with the Teams permission hint.
   */
  async get_channel_files_folder(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsFilesFolderRef | 'unavailable' | undefined> {
    let folder: GraphFilesFolder;
    try {
      folder = await with_graph_retry(
        () =>
          this._client
            .api(
              `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/filesFolder`,
            )
            .get() as Promise<GraphFilesFolder>,
      );
    } catch (err) {
      const status = graph_status_of(err);
      if (status === 404) return undefined;
      if (status === 403) return 'unavailable';
      throw err;
    }
    const drive_id = folder.parentReference?.driveId;
    if (!folder.id || !drive_id) return undefined;
    return folder.webUrl === undefined
      ? { drive_id, item_id: folder.id }
      : { drive_id, item_id: folder.id, web_url: folder.webUrl };
  }

  /** Reads one page of channel message changes; `url` undefined starts the delta feed. */
  async fetch_message_delta_page(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
    url: string | undefined,
  ): Promise<TeamsMessageDeltaPage> {
    return fetch_message_delta_page(this._client, team_id, channel_id, url);
  }

  /** Reads one page of a channel's root messages with `/messages`. */
  async list_channel_messages_page(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
    url: string | undefined,
  ): Promise<TeamsMessageListPage> {
    return list_channel_messages_page(this._client, team_id, channel_id, url);
  }

  /**
   * Reads one root message without its replies. Resolves `not_found` when Graph answers 404, so
   * the caller can tell a missing root from a read that succeeded.
   */
  async get_channel_message(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
    root_id: string,
  ): Promise<TeamsRootFetchResult> {
    return get_channel_message(this._client, team_id, channel_id, root_id);
  }

  /** Lists every reply of a root message, including deleted replies. */
  async list_replies(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
    root_id: string,
  ): Promise<TeamsGraphResource[]> {
    return list_replies(this._client, team_id, channel_id, root_id);
  }

  /** Lists the hosted contents of a root message or, with `reply_id`, of a reply. */
  async list_hosted_contents(
    _tenant_id: string,
    locator: TeamsMessageLocator,
  ): Promise<TeamsGraphResource[]> {
    return list_hosted_contents(this._client, locator);
  }

  /** Downloads one hosted content item's bytes. */
  async download_hosted_content(
    _tenant_id: string,
    locator: TeamsMessageLocator,
    hosted_id: string,
  ): Promise<TeamsHostedContent> {
    return download_hosted_content(this._client, locator, hosted_id);
  }
}
