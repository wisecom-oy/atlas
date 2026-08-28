import type { MessageAttachment } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { GraphAttachmentRecord } from '@/adapters/graph-mailbox-response-mappers';

/** Placeholder until the downloaded bytes reveal what kind of item was attached. */
export const ITEM_ATTACHMENT_PENDING_TYPE = 'application/vnd.atlas.item-attachment';

const FILE_ATTACHMENT = '#microsoft.graph.fileAttachment';
const ITEM_ATTACHMENT = '#microsoft.graph.itemAttachment';
const REFERENCE_ATTACHMENT = '#microsoft.graph.referenceAttachment';

/**
 * Maps a message's Graph attachment records to storable attachments.
 *
 * All three documented attachment types are represented. Only the JSON
 * fallback path reaches this code: a message stored as MIME carries its
 * attachments inside the message bytes, so nothing here runs for it.
 *
 * - **fileAttachment** carries `contentBytes` inline unless it exceeds the
 *   Graph inline limit, in which case the connector fetches `/$value`.
 * - **itemAttachment** (an attached mail, invite, or contact) never carries
 *   inline bytes. `/$value` returns it as MIME, and the concrete type is only
 *   known once those bytes arrive, so it starts as
 *   {@link ITEM_ATTACHMENT_PENDING_TYPE}.
 * - **referenceAttachment** is a cloud link with no bytes at all. Graph answers
 *   `405` for its `/$value`, so the link itself is stored as `text/uri-list`;
 *   the linked file lives in OneDrive or SharePoint and is covered by those
 *   backups.
 */
export function map_attachments(records: GraphAttachmentRecord[]): MessageAttachment[] {
  const results: MessageAttachment[] = [];

  for (const record of records) {
    const mapped = map_one_attachment(record);
    if (mapped) results.push(mapped);
  }

  return results;
}

function map_one_attachment(record: GraphAttachmentRecord): MessageAttachment | undefined {
  switch (record['@odata.type']) {
    case FILE_ATTACHMENT:
      return map_file_attachment(record);
    case ITEM_ATTACHMENT:
      return map_item_attachment(record);
    case REFERENCE_ATTACHMENT:
      return map_reference_attachment(record);
    default:
      return map_unknown_attachment(record);
  }
}

function map_file_attachment(record: GraphAttachmentRecord): MessageAttachment {
  if (!record.contentBytes) {
    logger.debug(
      `Attachment "${record.name ?? '?'}" (${record.size ?? 0} bytes) has no inline contentBytes -- ` +
        `will download via /$value`,
    );
    return base_attachment(record, {
      content_type: record.contentType ?? 'application/octet-stream',
      content: Buffer.alloc(0),
    });
  }

  return base_attachment(record, {
    content_type: record.contentType ?? 'application/octet-stream',
    content: Buffer.from(record.contentBytes, 'base64'),
  });
}

/**
 * An attached Outlook item. Content always arrives from `/$value`, so this
 * carries an empty buffer and a placeholder content type for the connector to
 * resolve.
 */
function map_item_attachment(record: GraphAttachmentRecord): MessageAttachment {
  return base_attachment(record, {
    content_type: ITEM_ATTACHMENT_PENDING_TYPE,
    content: Buffer.alloc(0),
    // Graph reports 0 for some item attachments, which would otherwise read as
    // "nothing to download". The real length replaces this after the fetch.
    size_bytes: record.size !== undefined && record.size > 0 ? record.size : 1,
  });
}

/**
 * A cloud link. There are no bytes to fetch, so the link is the content: a
 * one-line `text/uri-list`, which mail clients and text editors both open.
 */
function map_reference_attachment(record: GraphAttachmentRecord): MessageAttachment {
  const source_url = record.sourceUrl ?? '';
  if (!source_url) {
    logger.warn(
      `Reference attachment "${record.name ?? '?'}" has no sourceUrl; storing its name only`,
    );
  }

  const content = Buffer.from(source_url === '' ? '' : `${source_url}\r\n`, 'utf-8');
  return base_attachment(record, {
    content_type: 'text/uri-list',
    content,
    size_bytes: content.length,
  });
}

/**
 * An attachment type Graph introduced after this code was written. Recorded
 * with its metadata rather than skipped, so a gap is auditable instead of
 * invisible.
 */
function map_unknown_attachment(record: GraphAttachmentRecord): MessageAttachment | undefined {
  const type = record['@odata.type'];
  if (type === undefined) return undefined;

  logger.warn(
    `Attachment "${record.name ?? '?'}" has unsupported type ${type}; ` +
      `storing metadata only, its content is not backed up`,
  );
  return base_attachment(record, {
    content_type: 'application/octet-stream',
    content: Buffer.alloc(0),
    size_bytes: 0,
  });
}

function base_attachment(
  record: GraphAttachmentRecord,
  overrides: { content_type: string; content: Buffer; size_bytes?: number },
): MessageAttachment {
  return {
    attachment_id: record.id ?? '',
    name: record.name ?? '',
    content_type: overrides.content_type,
    size_bytes: overrides.size_bytes ?? record.size ?? 0,
    is_inline: record.isInline === true,
    content: overrides.content,
    content_id: record.contentId ?? '',
  };
}

/**
 * Names the content type of a downloaded item attachment from its own bytes.
 *
 * Graph reports the attached item's kind nowhere on the attachment record, and
 * `/$value` returns a different format for each: MIME for a message, iCal for
 * an event, vCard for a contact. Sniffing labels what actually arrived rather
 * than guessing from a name, and an `.ics` mislabelled as `message/rfc822`
 * opens as broken mail instead of a calendar entry.
 */
export function detect_item_attachment_content_type(content: Buffer): string {
  const head = content.subarray(0, 64).toString('utf-8').trimStart().toUpperCase();
  if (head.startsWith('BEGIN:VCALENDAR')) return 'text/calendar';
  if (head.startsWith('BEGIN:VCARD')) return 'text/vcard';
  return 'message/rfc822';
}

/** Appends the extension implied by a resolved item attachment type, if missing. */
export function item_attachment_filename(name: string, content_type: string): string {
  const extension = ITEM_EXTENSIONS[content_type];
  if (extension === undefined) return name;
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

/**
 * Fills in what only the downloaded bytes can tell us.
 *
 * An item attachment's kind is invisible on its Graph record, so its content
 * type and file extension are resolved here; a file attachment keeps the type
 * Graph reported. Both get their real byte length, since Graph's reported
 * `size` counts the item as stored in the mailbox rather than the bytes
 * `/$value` returns.
 */
export function resolve_downloaded_attachment(
  attachment: MessageAttachment,
  content: Buffer,
): MessageAttachment {
  if (attachment.content_type !== ITEM_ATTACHMENT_PENDING_TYPE) {
    return { ...attachment, content, size_bytes: content.length };
  }

  const content_type = detect_item_attachment_content_type(content);
  return {
    ...attachment,
    content,
    content_type,
    name: item_attachment_filename(attachment.name, content_type),
    size_bytes: content.length,
  };
}

const ITEM_EXTENSIONS: Record<string, string> = {
  'message/rfc822': '.eml',
  'text/calendar': '.ics',
  'text/vcard': '.vcf',
};
