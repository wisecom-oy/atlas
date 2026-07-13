/**
 * Pure mapping helpers for Graph delta-sync responses: the field selection
 * list, response shapes, and conversion of raw Graph messages into MailMessage.
 */

import type { MailMessage } from '@wisecom/atlas-types';
import type { GraphUserRecord, GraphFolderRecord } from '@/adapters/graph-mailbox-response-mappers';

/**
 * Fields to request from the delta endpoint so each page contains
 * the full message body, eliminating the need for per-message fetches.
 */
export const DELTA_SELECT_FIELDS = [
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

export interface GraphPageResponse {
  value?: GraphUserRecord[] | GraphFolderRecord[] | GraphDeltaMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface GraphDeltaMessage {
  id?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  receivedDateTime?: string;
  parentFolderId?: string;
  '@removed'?: { reason: string };
  [key: string]: unknown;
}

/** Converts a raw Graph message response into our MailMessage domain type. */
export function graph_message_to_mail_message(msg: GraphDeltaMessage): MailMessage {
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

/** Separates delta page items into live messages and removed message IDs. */
export function extract_page_messages(
  items: GraphDeltaMessage[],
  removed_ids: string[],
): MailMessage[] {
  const page_messages: MailMessage[] = [];
  for (const item of items) {
    if (item['@removed'] && item.id) {
      removed_ids.push(item.id);
    } else if (item.id) {
      page_messages.push(graph_message_to_mail_message(item));
    }
  }
  return page_messages;
}
