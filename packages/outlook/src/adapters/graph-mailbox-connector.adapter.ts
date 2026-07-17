import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { ResponseType } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';
import type {
  MailboxConnector,
  MailboxPurpose,
  MailFolder,
  MailMessage,
  MessageAttachment,
  DeltaSyncResult,
  DeltaPageCallback,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  is_invalid_delta_error,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@wisecom/atlas-m365-graph';
import type {
  GraphUserRecord,
  GraphFolderRecord,
  GraphAttachmentRecord,
} from '@/adapters/graph-mailbox-response-mappers';
import {
  extract_user_ids,
  filter_and_map_folders,
  map_file_attachments,
  parse_mailbox_purpose,
} from '@/adapters/graph-mailbox-response-mappers';
import type { GraphPageResponse, GraphDeltaMessage } from '@/adapters/graph-delta-message-mapper';
import {
  DELTA_SELECT_FIELDS,
  extract_page_messages,
  graph_message_to_mail_message,
} from '@/adapters/graph-delta-message-mapper';

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
      const user_records = await with_graph_retry(() =>
        this.collect_all_pages<GraphUserRecord>(url),
      );
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
      const res = await with_graph_retry(() =>
        this._client.api(`/users/${owner_id}/mailboxSettings?$select=userPurpose`).get(),
      );
      return parse_mailbox_purpose((res as { userPurpose?: unknown } | undefined)?.userPurpose);
    } catch (err) {
      // ponytail: swallow-all — 403/404 on some shared/resource mailboxes is a known Graph quirk
      logger.debug(`mailboxSettings lookup failed for ${owner_id}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Lists all mail folders for a mailbox, excluding system folders
   * (drafts, outbox, junk, recoverable items).
   */
  async list_mail_folders(_tenant_id: string, owner_id: string): Promise<MailFolder[]> {
    try {
      const url =
        `/users/${owner_id}/mailFolders` +
        '?$select=id,displayName,parentFolderId,totalItemCount&$top=250';
      const folder_records = await with_graph_retry(() =>
        this.collect_all_pages<GraphFolderRecord>(url),
      );
      return filter_and_map_folders(folder_records);
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Fetches messages changed since the previous delta link for one folder.
   * If prev_delta_link is provided, resumes from that point.
   * Falls back to full enumeration when Graph reports an invalid delta state.
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
    const ps = page_size ?? 10;

    try {
      return await this.execute_delta_sync(
        owner_id,
        folder_id,
        prev_delta_link,
        false,
        on_page,
        ps,
      );
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      if (is_invalid_delta_error(err)) {
        logger.debug('fetch_delta: invalid delta token, falling back to full sync');
        return await this.execute_delta_sync(owner_id, folder_id, undefined, true, on_page, ps);
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
            .get() as Promise<GraphDeltaMessage>,
      );

      return graph_message_to_mail_message(response);
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Fetches file attachments for a message. Filters to fileAttachment type only,
   * decodes contentBytes from base64. Attachments above the Graph inline limit
   * (~3 MB) arrive without contentBytes and are downloaded individually via the
   * /$value endpoint, which streams raw bytes with no size ceiling.
   */
  async fetch_attachments(
    _tenant_id: string,
    owner_id: string,
    message_id: string,
  ): Promise<MessageAttachment[]> {
    try {
      const url = `/users/${owner_id}/messages/${message_id}/attachments`;
      const records = await with_graph_retry(() =>
        this.collect_all_pages<GraphAttachmentRecord>(url),
      );
      const attachments = map_file_attachments(records);

      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i]!;
        if (att.content.length > 0 || att.size_bytes === 0 || !att.attachment_id) continue;
        const content = await this.download_attachment_content(
          owner_id,
          message_id,
          att.attachment_id,
        );
        attachments[i] = { ...att, content };
      }
      return attachments;
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Downloads raw attachment bytes via /attachments/{id}/$value. Raw transfer
   * avoids the +33% base64 overhead of contentBytes. Each attachment gets its
   * own retry window so a large binary cannot starve the page-listing budget.
   */
  private async download_attachment_content(
    owner_id: string,
    message_id: string,
    attachment_id: string,
  ): Promise<Buffer> {
    const url = `/users/${owner_id}/messages/${message_id}/attachments/${attachment_id}/$value`;
    const data = await with_graph_retry(
      () =>
        this._client.api(url).responseType(ResponseType.ARRAYBUFFER).get() as Promise<ArrayBuffer>,
    );
    return Buffer.from(data);
  }

  // ---------------------------------------------------------------------------
  // Delta sync internals
  // ---------------------------------------------------------------------------

  /** Returns the delta endpoint path for a mailbox folder (no query params). */
  private delta_path(owner_id: string, folder_id: string): string {
    return `/users/${owner_id}/mailFolders/${folder_id}/messages/delta`;
  }

  /**
   * Fetches the first page of an initial delta request using the SDK fluent API.
   * Uses Prefer: odata.maxpagesize to request larger pages and reduce round-trips.
   * The server may return fewer items; $top is intentionally avoided as it caps
   * total results across pages for delta queries.
   */
  private async fetch_initial_delta_page(
    owner_id: string,
    folder_id: string,
    page_size: number,
  ): Promise<GraphPageResponse> {
    return with_graph_retry(
      () =>
        this._client
          .api(this.delta_path(owner_id, folder_id))
          .header('Prefer', `odata.maxpagesize=${page_size}`)
          .select(DELTA_SELECT_FIELDS)
          .get() as Promise<GraphPageResponse>,
    );
  }

  /**
   * Fetches a page using a full @odata.nextLink or @odata.deltaLink URL.
   * The Prefer header is re-sent on each request to ensure larger pages.
   */
  private async fetch_continuation_page(
    full_url: string,
    page_size: number,
  ): Promise<GraphPageResponse> {
    return with_graph_retry(
      () =>
        this._client
          .api(full_url)
          .header('Prefer', `odata.maxpagesize=${page_size}`)
          .get() as Promise<GraphPageResponse>,
    );
  }

  /**
   * Runs a complete delta sync for a folder. Pages through all results,
   * directly converting each message to a MailMessage (body included in
   * the delta response, so no per-message fetches are needed).
   */
  private async execute_delta_sync(
    owner_id: string,
    folder_id: string,
    prev_delta_link: string | undefined,
    delta_reset: boolean,
    on_page?: DeltaPageCallback,
    page_size = 10,
  ): Promise<DeltaSyncResult> {
    const is_initial = !prev_delta_link;
    const messages: MailMessage[] = [];
    const removed_ids: string[] = [];
    let delta_link = '';
    let page_count = 0;
    let total_streamed = 0;

    let page: GraphPageResponse = is_initial
      ? await this.fetch_initial_delta_page(owner_id, folder_id, page_size)
      : await this.fetch_continuation_page(prev_delta_link, page_size);

    while (true) {
      page_count++;
      const items = (page.value ?? []) as GraphDeltaMessage[];
      const page_messages = extract_page_messages(items, removed_ids);

      const callback_result = await this.handle_page_callback(
        on_page,
        page_count,
        total_streamed,
        page_messages,
        messages,
      );
      total_streamed = callback_result.new_total_streamed;

      if (page['@odata.deltaLink']) {
        delta_link = page['@odata.deltaLink'];
      }

      if (callback_result.should_continue === false) break;

      const next_url = page['@odata.nextLink'];
      if (!next_url) break;

      page = await this.fetch_continuation_page(next_url, page_size);
    }

    return { messages, removed_ids, delta_link, delta_reset };
  }

  /** Invokes the page callback or accumulates messages; returns continuation flag. */
  private async handle_page_callback(
    on_page: DeltaPageCallback | undefined,
    page_count: number,
    total_streamed: number,
    page_messages: MailMessage[],
    messages: MailMessage[],
  ): Promise<{ should_continue: boolean | void; new_total_streamed: number }> {
    if (!on_page) {
      messages.push(...page_messages);
      return { should_continue: true, new_total_streamed: total_streamed };
    }

    const new_total_streamed = total_streamed + page_messages.length;
    const cb_result = on_page(page_count, new_total_streamed, page_messages);
    const should_continue = cb_result instanceof Promise ? await cb_result : cb_result;
    return { should_continue, new_total_streamed };
  }

  // ---------------------------------------------------------------------------
  // Pagination helpers
  // ---------------------------------------------------------------------------

  /** Generic paginator that follows @odata.nextLink and collects all items. */
  private async collect_all_pages<T>(start_url: string): Promise<T[]> {
    const all_items: T[] = [];
    let current_url: string | undefined = start_url;

    while (current_url) {
      const page = await this.fetch_continuation_page(current_url, 100);
      if (page.value) {
        all_items.push(...(page.value as T[]));
      }
      current_url = page['@odata.nextLink'];
    }

    return all_items;
  }
}
