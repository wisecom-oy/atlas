import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import type {
  TeamsConnector,
  TeamsFilesFolderRef,
  TeamsGraphResource,
  TeamsMessageDeltaResult,
  TeamsMessageLocator,
  TeamsRootChange,
} from '@wisecom/atlas-types';
import { graph_teams_call, read_all_pages } from '@/adapters/graph-teams-request';
import { graph_status_of } from '@/services/shared/graph-error-status';
import { fetch_message_delta, list_channel_messages } from '@/adapters/graph-teams-message-fetch';
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
      () => this._client.api(`/teams/${team_id}`).get() as Promise<TeamsGraphResource>,
    );
  }

  /** Lists the team's members. */
  async list_team_members(_tenant_id: string, team_id: string): Promise<TeamsGraphResource[]> {
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      `/teams/${team_id}/members`,
    );
    return items;
  }

  /** Lists the team's channels. */
  async list_channels(_tenant_id: string, team_id: string): Promise<TeamsGraphResource[]> {
    const { items } = await read_all_pages<TeamsGraphResource>(
      this._client,
      `/teams/${team_id}/channels`,
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
      `/teams/${team_id}/channels/${channel_id}/members`,
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
      `/teams/${team_id}/channels/${channel_id}/tabs?$expand=teamsApp`,
    );
    return items;
  }

  /**
   * Resolves the channel's Files folder to its SharePoint drive item. Resolves undefined when
   * Graph has no folder for the channel (404).
   */
  async get_channel_files_folder(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsFilesFolderRef | undefined> {
    let folder: GraphFilesFolder;
    try {
      folder = await graph_teams_call(
        () =>
          this._client
            .api(`/teams/${team_id}/channels/${channel_id}/filesFolder`)
            .get() as Promise<GraphFilesFolder>,
      );
    } catch (err) {
      if (graph_status_of(err) === 404) return undefined;
      throw err;
    }
    const drive_id = folder.parentReference?.driveId;
    if (!folder.id || !drive_id) return undefined;
    return folder.webUrl === undefined
      ? { drive_id, item_id: folder.id }
      : { drive_id, item_id: folder.id, web_url: folder.webUrl };
  }

  /** Reads channel message changes since `prev_delta_link`, or everything when it is undefined. */
  async fetch_message_delta(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
    prev_delta_link: string | undefined,
  ): Promise<TeamsMessageDeltaResult> {
    return fetch_message_delta(this._client, team_id, channel_id, prev_delta_link);
  }

  /** Reads every root message in a channel with `/messages`. */
  async list_channel_messages(
    _tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsRootChange[]> {
    return list_channel_messages(this._client, team_id, channel_id);
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
  ): Promise<Buffer> {
    return download_hosted_content(this._client, locator, hosted_id);
  }
}
