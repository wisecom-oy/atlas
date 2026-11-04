import type { TeamsFilesFolderRef, TeamsGraphResource } from '@/domain/teams/manifest';

/** A channel root message reported by a read. `deleted` roots carry only their `id`. */
export interface TeamsRootChange {
  readonly root: TeamsGraphResource;
  /** A root Graph reports removed (`@removed`) or with `deletedDateTime` set. */
  readonly deleted: boolean;
  /** Replies inlined by `$expand=replies` when Graph returned them complete; absent otherwise. */
  readonly replies?: TeamsGraphResource[] | undefined;
}

/** Result of re-reading one root: its change, or `not_found` when Graph answers 404 for it. */
export type TeamsRootFetchResult =
  { readonly status: 'found'; readonly change: TeamsRootChange } | { readonly status: 'not_found' };

/** One page of a channel message delta read. `delta_link` is set on the last page only. */
export interface TeamsMessageDeltaPage {
  /** Every root whose thread changed on this page, including reply-only changes. */
  readonly roots: TeamsRootChange[];
  /** Graph's `@odata.nextLink`; absent on the last page. */
  readonly next_link?: string | undefined;
  /** Graph's `@odata.deltaLink`, on the last page. Persist it only once the work it covers is durable. */
  readonly delta_link?: string | undefined;
}

/** One page of a channel `/messages` list read. */
export interface TeamsMessageListPage {
  readonly roots: TeamsRootChange[];
  /** Graph's `@odata.nextLink`; absent on the last page. */
  readonly next_link?: string | undefined;
}

/** Addresses one thread, or one reply inside it, for hosted-content calls. */
export interface TeamsMessageLocator {
  readonly team_id: string;
  readonly channel_id: string;
  readonly root_id: string;
  /** Set to address a reply's hosted content; absent for the root message's own content. */
  readonly reply_id?: string | undefined;
}

/** One hosted-content download: its bytes and the Content-Type Graph sent with them. */
export interface TeamsHostedContent {
  readonly bytes: Buffer;
  readonly content_type?: string | undefined;
}

/**
 * Read access to Teams teams, channels, and channel messages through Microsoft Graph (app-only).
 *
 * Methods throw the Graph error unchanged. Delta callers treat a 400 or `is_invalid_delta_error`
 * as "read this channel in full": they restart from the first page of
 * {@link list_channel_messages_page}.
 */
export interface TeamsConnector {
  /** Lists every team in the tenant. */
  list_teams(tenant_id: string): Promise<TeamsGraphResource[]>;

  /** Fetches one team (`/teams/{id}`) with its settings. */
  get_team(tenant_id: string, team_id: string): Promise<TeamsGraphResource>;

  /** Lists the team's members (`/teams/{id}/members`). */
  list_team_members(tenant_id: string, team_id: string): Promise<TeamsGraphResource[]>;

  /** Lists the team's channels (`/teams/{id}/channels`). */
  list_channels(tenant_id: string, team_id: string): Promise<TeamsGraphResource[]>;

  /** Lists a channel's members. */
  list_channel_members(
    tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsGraphResource[]>;

  /** Lists a channel's tabs with `teamsApp` expanded. */
  list_channel_tabs(
    tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsGraphResource[]>;

  /**
   * Resolves the channel's Files folder to its SharePoint drive item. Resolves undefined when
   * Graph has no folder for the channel, and `unavailable` when the app is refused access (403).
   */
  get_channel_files_folder(
    tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsFilesFolderRef | 'unavailable' | undefined>;

  /** Lists the teams a shared channel is shared with (`/channels/{id}/sharedWithTeams`). */
  list_channel_shared_teams(
    tenant_id: string,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsGraphResource[]>;

  /**
   * Reads one page of channel message changes. `url` undefined starts the delta read (no link:
   * every change Graph still holds); otherwise it is a `next_link` or the stored delta link.
   * Each page is one paged request; callers loop, applying each page before reading the next.
   */
  fetch_message_delta_page(
    tenant_id: string,
    team_id: string,
    channel_id: string,
    url: string | undefined,
  ): Promise<TeamsMessageDeltaPage>;

  /**
   * Reads one page of the channel's root messages with `/messages`. `url` undefined starts from
   * the first page; otherwise it is a `next_link`. Returns no deleted roots and no delta link.
   */
  list_channel_messages_page(
    tenant_id: string,
    team_id: string,
    channel_id: string,
    url: string | undefined,
  ): Promise<TeamsMessageListPage>;

  /**
   * Reads one root message, without replies (callers use {@link list_replies}). Resolves
   * `not_found` on a 404, which is not evidence the root was removed: only a delta removal or a
   * full read that omits the root removes it.
   */
  get_channel_message(
    tenant_id: string,
    team_id: string,
    channel_id: string,
    root_id: string,
  ): Promise<TeamsRootFetchResult>;

  /**
   * Lists every reply of a root message, paged, including deleted replies. Graph has no delta
   * for replies, so callers refetch the full list for each changed root.
   */
  list_replies(
    tenant_id: string,
    team_id: string,
    channel_id: string,
    root_id: string,
  ): Promise<TeamsGraphResource[]>;

  /** Lists the `hostedContents` (inline images) of a root or, with `reply_id`, of a reply. */
  list_hosted_contents(
    tenant_id: string,
    locator: TeamsMessageLocator,
  ): Promise<TeamsGraphResource[]>;

  /** Downloads one hosted content item's bytes and Content-Type (`.../hostedContents/{id}/$value`). */
  download_hosted_content(
    tenant_id: string,
    locator: TeamsMessageLocator,
    hosted_id: string,
  ): Promise<TeamsHostedContent>;
}
