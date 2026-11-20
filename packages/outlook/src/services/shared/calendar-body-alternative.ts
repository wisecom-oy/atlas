import mailsplit from '@zone-eu/mailsplit';
import type { SplitterChunk } from '@zone-eu/mailsplit';
import type { Attachment, ParsedMail } from 'mailparser';

const CALENDAR_CONTENT_TYPE = 'text/calendar';

/**
 * Returns the attachments mailparser reported, without the calendar alternative of a body that
 * was read.
 *
 * A meeting request or response carries its iCalendar data as a third `multipart/alternative`
 * child beside the plain and HTML body. mailparser reports every part that is neither as an
 * attachment, so restore uploaded that part as a file named `attachment` (issue #817). Exchange
 * reads it as body content instead ([MS-OXCMAIL] 2.2.3.3.2): a child of `multipart/alternative`
 * qualifies as the message body unless it says `Content-Disposition: attachment`.
 *
 * The part is kept when no other body was read. It is then the only copy of the content the
 * message shows, and dropping it would restore an empty message.
 */
export async function exclude_calendar_body_alternatives(
  mime: Buffer,
  parsed: ParsedMail,
): Promise<Attachment[]> {
  const has_readable_body = Boolean(parsed.text) || typeof parsed.html === 'string';
  if (!has_readable_body || !parsed.attachments.some(is_calendar_body_candidate)) {
    return parsed.attachments;
  }

  // The second pass over the bytes runs only for a message that has a candidate part, so ordinary
  // mail is still parsed once.
  const alternative_part_ids = await find_calendar_alternative_part_ids(mime);
  return parsed.attachments.filter(
    (attachment) =>
      !is_calendar_body_candidate(attachment) ||
      attachment.partId === null ||
      !alternative_part_ids.has(attachment.partId),
  );
}

/** Whether mailparser's attachment is a calendar part that does not ask to be an attachment. */
function is_calendar_body_candidate(attachment: Attachment): boolean {
  return (
    attachment.contentType === CALENDAR_CONTENT_TYPE &&
    attachment.contentDisposition !== 'attachment'
  );
}

/**
 * Walks the MIME tree and returns the part number of every `text/calendar` child of a
 * `multipart/alternative`.
 *
 * mailparser does not say which multipart a part sits in, and that is the whole difference
 * between a body alternative and a calendar file under `multipart/mixed`. mailsplit is the
 * splitter mailparser itself runs, so the part numbers match `Attachment.partId`.
 */
async function find_calendar_alternative_part_ids(mime: Buffer): Promise<Set<string>> {
  const part_ids = new Set<string>();
  const splitter = new mailsplit.Splitter();
  splitter.end(mime);
  for await (const chunk of splitter as AsyncIterable<SplitterChunk>) {
    if (chunk.type !== 'node' || !is_calendar_alternative_node(chunk)) continue;
    part_ids.add(format_part_id(chunk.partNr));
  }
  return part_ids;
}

type MimeNode = Extract<SplitterChunk, { type: 'node' }>;

/** Whether a MIME node is a `text/calendar` child of a `multipart/alternative`. */
function is_calendar_alternative_node(node: MimeNode): boolean {
  return (
    node.contentType === CALENDAR_CONTENT_TYPE &&
    node.parentNode !== false &&
    node.parentNode.multipart === 'alternative'
  );
}

/** Formats a mailsplit part number the way mailparser formats `Attachment.partId`. */
function format_part_id(part_number: MimeNode['partNr']): string {
  return (part_number || []).filter((segment) => typeof segment === 'number').join('.');
}
