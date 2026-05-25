import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import { GRAPH_CLIENT_TOKEN } from '@atlas/m365-graph';
import type {
  MailboxConnector,
  MailFolder,
  MailMessage,
  MessageAttachment,
  DeltaSyncResult,
  DeltaPageCallback,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';
import {
  is_invalid_delta_error,
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  with_graph_retry,
} from '@atlas/m365-graph';
import type {
  GraphUserRecord,
  GraphFolderRecord,
  GraphAttachmentRecord,
} from '@/adapters/graph-mailbox-response-mappers';
import {
  extract_user_ids,
  filter_and_map_folders,
  map_file_attachments,
} from '@/adapters/graph-mailbox-response-mappers';

/**
 * Fields to request from the delta endpoint so each page contains
 * the full message body, eliminating the need for per-message fetches.
 */
const DELTA_SELECT_FIELDS = [
  'id',
  'subject',
  'body',
  'bodyPreview',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'createdDateTime',
  'lastModifiedDateTime',
  'parentFolderId',
  'importance',
  'isRead',
  'isDraft',
  'hasAttachments',
  'internetMessageId',
  'conversationId',
  'flag',
  'categories',
].join(',');

interface GraphPageResponse {
  value?: GraphUserRecord[] | GraphFolderRecord[] | GraphDeltaMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphDeltaMessage {
  id?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  receivedDateTime?: string;
  parentFolderId?: string;
  '@removed'?: { reason: string };
  [key: string]: unknown;
}

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

      return this.graph_message_to_mail_message(response);
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
  }

  /**
   * Fetches file attachments for a message. Filters to fileAttachment type only,
   * decodes contentBytes from base64. Logs a warning and skips storage for
   * attachments where contentBytes is missing (typically >4MB).
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
      return map_file_attachments(records);
    } catch (err) {
      rethrow_if_mailbox_not_licensed(err);
      rethrow_if_access_denied(err);
      throw err;
    }
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
      const page_messages = this.extract_page_messages(items, removed_ids);

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

  /** Separates delta page items into live messages and removed message IDs. */
  private extract_page_messages(items: GraphDeltaMessage[], removed_ids: string[]): MailMessage[] {
    const page_messages: MailMessage[] = [];
    for (const item of items) {
      if (item['@removed'] && item.id) {
        removed_ids.push(item.id);
      } else if (item.id) {
        page_messages.push(this.graph_message_to_mail_message(item));
      }
    }
    return page_messages;
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

  /** Converts a raw Graph message response into our MailMessage domain type. */
  private graph_message_to_mail_message(msg: GraphDeltaMessage): MailMessage {
    const body_buffer = Buffer.from(JSON.stringify(msg));
    return {
      message_id: msg.id ?? '',
      folder_id: (msg.parentFolderId as string) ?? '',
      subject: (msg.subject as string) ?? '',
      received_at: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
      size_bytes: body_buffer.length,
      raw_body: body_buffer,
      has_attachments: msg.hasAttachments === true,
    };
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
