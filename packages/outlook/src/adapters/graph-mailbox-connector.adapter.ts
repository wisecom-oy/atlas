import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  MailboxConnector,
  MailboxPurpose,
  MailFolder,
  MailFolderListOptions,
  MailMessage,
  MessageAttachment,
  DeltaSyncResult,
  DeltaPageCallback,
  ExtendedProperty,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { map_attachments, resolve_downloaded_attachment } from '@/adapters/graph-attachment-mapper';
import {
  GRAPH_CLIENT_TOKEN,
  is_invalid_delta_error,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import { fetch_message_mime } from '@/adapters/graph-message-mime-fetcher';
import { fetch_message_reaction_properties } from '@/adapters/graph-message-reaction-fetcher';
import { fetch_attachment_content } from '@/adapters/graph-attachment-content-fetcher';
import {
  extract_user_ids,
  parse_mailbox_settings_purpose,
  type GraphUserRecord,
  type GraphFolderRecord,
  type GraphAttachmentRecord,
} from '@/adapters/graph-mailbox-response-mappers';
import { create_folder_reader, list_mail_folder_tree } from '@/adapters/graph-mail-folder-listing';
import type { GraphDeltaMessage } from '@/adapters/graph-delta-message-mapper';
import { graph_message_to_mail_message } from '@/adapters/graph-delta-message-mapper';
import {
  IMMUTABLE_ID_PREFER,
  create_delta_handover,
  fetch_mail_continuation_page,
  run_mail_delta_pass,
} from '@/adapters/graph-mail-delta-sync';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

@injectable()
export class GraphMailboxConnector implements MailboxConnector {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /**
   * Lists all user mailbox IDs in the tenant by paging through the /users endpoint.
   * Only returns users that have a mail address set.
   */
  async list_mailboxes(_tenant_id: string): Promise<string[]> {
    try {
      const url = '/users?$select=id,mail,displayName&$filter=mail ne null&$top=999';
      const user_records = await this.collect_all_pages<GraphUserRecord>(url);
      return extract_user_ids(user_records);
    } catch (err) {
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Checks whether a mailbox exists in the tenant via GET /users/{id}. */
  async mailbox_exists(_tenant_id: string, owner_id: string): Promise<boolean> {
    try {
      await with_graph_retry(() => this._client.api(`/users/${owner_id}?$select=id`).get());
      return true;
    } catch (err) {
      if ((err as Record<string, unknown>).statusCode === 404) return false;
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Resolves userPurpose from mailboxSettings; returns undefined on any error (metadata must never fail a backup). */
  async get_mailbox_purpose(
    _tenant_id: string,
    owner_id: string,
  ): Promise<MailboxPurpose | undefined> {
    try {
      return parse_mailbox_settings_purpose(
        await with_graph_retry(() =>
          this._client.api(`/users/${owner_id}/mailboxSettings?$select=userPurpose`).get(),
        ),
      );
    } catch (err) {
      // ponytail: swallow-all — 403/404 on some shared/resource mailboxes is a known Graph quirk
      logger.debug(`mailboxSettings lookup failed for ${owner_id}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Lists every mail folder in the mailbox, at any nesting depth. */
  async list_mail_folders(
    _tenant_id: string,
    owner_id: string,
    options?: MailFolderListOptions,
  ): Promise<MailFolder[]> {
    try {
      return await list_mail_folder_tree(
        (url) => this.collect_all_pages<GraphFolderRecord>(url),
        owner_id,
        options,
        create_folder_reader(
          // Folder reads resolve ids compared against the listing, so they need the same format.
          (url) =>
            with_graph_retry(() =>
              this._client.api(url).header('Prefer', IMMUTABLE_ID_PREFER).get(),
            ),
          owner_id,
        ),
      );
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Fetches messages changed since the previous delta link for one folder.
   * If prev_delta_link is provided, resumes from that point.
   * Falls back to full enumeration when Graph reports an invalid delta state, even mid-paging:
   * messages already handed to on_page are not handed over again, and removals already read are
   * kept (issue #642).
   */
  async fetch_delta(
    _tenant_id: string,
    owner_id: string,
    folder_id: string,
    prev_delta_link?: string,
    on_page?: DeltaPageCallback,
    page_size?: number,
  ): Promise<DeltaSyncResult> {
    logger.debug(
      prev_delta_link
        ? `fetch_delta: resuming from saved delta link`
        : `fetch_delta: starting initial full sync`,
    );
    const pass = { owner_id, folder_id, page_size: page_size ?? 10, on_page };
    const handover = create_delta_handover();

    try {
      return await run_mail_delta_pass(
        this._client,
        { ...pass, prev_delta_link, delta_reset: false },
        handover,
      );
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      if (is_invalid_delta_error(err)) {
        logger.debug(
          `fetch_delta: invalid delta token, falling back to full sync ` +
            `(${handover.handed_over_ids.size} message(s) already handed over)`,
        );
        return await run_mail_delta_pass(
          this._client,
          { ...pass, prev_delta_link: undefined, delta_reset: true },
          handover,
        );
      }
      throw err;
    }
  }

  /** Fetches a single message by ID, returning its full JSON body as a Buffer. */
  async fetch_message(
    _tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MailMessage> {
    try {
      const response = await with_graph_retry(
        () =>
          this._client
            .api(`/users/${owner_id}/messages/${message_id}`)
            .header('Prefer', IMMUTABLE_ID_PREFER)
            .get() as Promise<GraphDeltaMessage>,
      );

      return graph_message_to_mail_message(response);
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /** Fetches the message's original RFC 5322 MIME; undefined when Graph has none (issue #50). */
  async fetch_mime(
    _tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<Buffer | undefined> {
    return fetch_message_mime(this._client, owner_id, message_id, IMMUTABLE_ID_PREFER);
  }

  /** Reads reaction properties for a page of messages, 20 per `$batch` (issues #481, #513). */
  async fetch_reaction_properties(
    _tenant_id: string,
    owner_id: string,
    message_ids: readonly string[],
  ): Promise<Map<string, ExtendedProperty[]>> {
    return fetch_message_reaction_properties(
      this._client,
      owner_id,
      message_ids,
      IMMUTABLE_ID_PREFER,
    );
  }

  /**
   * Fetches a message's attachments, on the JSON fallback path only: a message
   * stored as MIME already carries its attachments inside the message bytes.
   *
   * File attachments above the Graph inline limit (~3 MB) arrive without
   * contentBytes, and item attachments never carry inline bytes at all, so both
   * are fetched individually from `/$value`, which streams raw bytes with no
   * size ceiling. Reference attachments are links with no content to fetch;
   * Graph answers `405` for their `/$value`, so they are never downloaded.
   */
  async fetch_attachments(
    _tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MessageAttachment[]> {
    try {
      const url = `/users/${owner_id}/messages/${message_id}/attachments`;
      const records = await this.collect_all_pages<GraphAttachmentRecord>(url);
      const attachments = map_attachments(records);

      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i]!;
        if (att.content.length > 0 || att.size_bytes === 0 || !att.attachment_id) continue;
        const content = await fetch_attachment_content(
          this._client,
          owner_id,
          message_id,
          att.attachment_id,
          IMMUTABLE_ID_PREFER,
        );
        attachments[i] = resolve_downloaded_attachment(att, content);
      }
      return attachments;
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Pagination helpers
  // ---------------------------------------------------------------------------

  /**
   * Generic paginator that follows @odata.nextLink and collects all items.
   * Retry/timeout lives INSIDE the loop (fetch_mail_continuation_page wraps each
   * page in with_graph_retry), so a failed page resumes from the current
   * nextLink. NEVER wrap calls to this in with_graph_retry: the outer 60s
   * timeout races the whole enumeration and restarts it from page 1 --
   * large tenants can never finish (issue #33).
   */
  private async collect_all_pages<T>(start_url: string): Promise<T[]> {
    const all_items: T[] = [];
    let current_url: string | undefined = start_url;

    while (current_url) {
      const page = await fetch_mail_continuation_page(this._client, current_url, 100);
      if (page.value) {
        append_all(all_items, page.value as T[]);
      }
      current_url = page['@odata.nextLink'];
    }

    return all_items;
  }
}
