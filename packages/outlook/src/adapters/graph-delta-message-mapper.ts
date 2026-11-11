/**
 * Pure mapping helpers for Graph delta-sync responses: the field selection
 * list, response shapes, and conversion of raw Graph messages into MailMessage.
 */

import type { FollowUpFlag, MailAddress, MailMessage, ZonedDateTime } from '@wisecom/atlas-types';
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

interface GraphDateTimeTimeZone {
  dateTime?: unknown;
  timeZone?: unknown;
}

export interface GraphDeltaMessage {
  id?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: unknown; address?: unknown } };
  flag?: {
    flagStatus?: unknown;
    startDateTime?: GraphDateTimeTimeZone;
    dueDateTime?: GraphDateTimeTimeZone;
    completedDateTime?: GraphDateTimeTimeZone;
  };
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
    ...(typeof msg.subject === 'string' ? { subject: msg.subject } : {}),
    ...(msg.receivedDateTime ? { received_at: new Date(msg.receivedDateTime) } : {}),
    ...parse_sender(msg.from),
    ...parse_follow_up_flag(msg.flag),
    size_bytes: body_buffer.length,
    raw_body: body_buffer,
    has_attachments: msg.hasAttachments === true,
  };
}

/** Reads Graph `from`; drafts and some system items have none, so the field is omitted. */
function parse_sender(from: GraphDeltaMessage['from']): { from?: MailAddress } {
  const address = from?.emailAddress?.address;
  if (typeof address !== 'string' || address === '') return {};
  const name = from?.emailAddress?.name;
  return { from: typeof name === 'string' && name !== '' ? { name, address } : { address } };
}

/** Reads Graph `flag`; a message that is not flagged, or has no flag field, records none. */
function parse_follow_up_flag(flag: GraphDeltaMessage['flag']): { flag?: FollowUpFlag } {
  const status = flag?.flagStatus;
  if (status !== 'flagged' && status !== 'complete') return {};
  const start = parse_zoned_date_time(flag?.startDateTime);
  const due = parse_zoned_date_time(flag?.dueDateTime);
  const completed = parse_zoned_date_time(flag?.completedDateTime);
  return {
    flag: {
      status,
      ...(start ? { start } : {}),
      ...(due ? { due } : {}),
      ...(completed ? { completed } : {}),
    },
  };
}

/** Reads a Graph `dateTimeTimeZone`, dropping one without both parts. */
function parse_zoned_date_time(
  value: GraphDateTimeTimeZone | undefined,
): ZonedDateTime | undefined {
  const date_time = value?.dateTime;
  const time_zone = value?.timeZone;
  if (typeof date_time !== 'string' || typeof time_zone !== 'string') return undefined;
  return { date_time, time_zone };
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
