import mailsplit from '@zone-eu/mailsplit';
import type { SplitterChunk } from '@zone-eu/mailsplit';
import type { Attachment, HeaderValue, ParsedMail, StructuredHeader } from 'mailparser';

const CALENDAR_CONTENT_TYPE = 'text/calendar';

/**
 * The iTIP methods Exchange builds a meeting item from. `PUBLISH` and `REFRESH` are left out on
 * purpose: Exchange delivers those as ordinary mail and keeps a calendar file they carry.
 */
const MEETING_METHODS = new Set(['REQUEST', 'REPLY', 'CANCEL', 'COUNTER']);

/** The part Exchange builds a meeting item from: its iTIP method and its iCalendar document. */
export interface MeetingCalendarPart {
  /** The `method` parameter of the part's Content-Type, in upper case. */
  readonly method: string;
  /** The `charset` parameter of the part's Content-Type, in lower case. */
  readonly charset?: string;
  /** The document as sent, transfer encoding undone and charset untouched. */
  readonly icalendar: Buffer;
}

/** A message's attachments, split from the calendar data Exchange reads as meeting content. */
export interface MeetingCalendarParts {
  /** Absent on ordinary mail, including mail that only carries a calendar file. */
  readonly meeting_part?: MeetingCalendarPart;
  /** The attachments the source mailbox listed, as far as the MIME can tell. */
  readonly attachments: Attachment[];
}

/** One `text/calendar` part mailparser reported as an attachment, with where and how it was sent. */
interface CalendarPart {
  readonly attachment: Attachment;
  readonly method: string | undefined;
  readonly is_body_alternative: boolean;
  readonly is_declared_attachment: boolean;
}

/**
 * Separates the calendar data of a meeting message from its real attachments.
 *
 * mailparser reports every part that is not `text/plain` or `text/html` as an attachment, so the
 * iCalendar data of a meeting request or response came back from restore as a file named
 * `attachment` (issue #817). Exchange does not list that part: it builds the meeting item from it.
 * The rules below are what Exchange Online did with 41 MIME variants imported for that issue.
 *
 * A calendar part is left out of the attachments when it does not say
 * `Content-Disposition: attachment` and one of these holds:
 *
 * - It is a child of `multipart/alternative`, which makes it another rendering of the body
 *   ([MS-OXCMAIL] 2.2.3.3.2), whatever its method.
 * - It has no file name and it is the meeting part, or a byte-for-byte copy of it.
 *
 * A part sent as an attachment, or under a file name outside the body, is always kept. Exchange
 * hides some of those too, but restoring a named calendar file is harmless and dropping one is
 * not. Nothing is left out of a message with no plain or HTML body either: the calendar part is
 * then the only copy of what the message shows.
 */
export async function separate_meeting_calendar_parts(
  mime: Buffer,
  parsed: ParsedMail,
): Promise<MeetingCalendarParts> {
  if (!parsed.attachments.some(is_calendar_attachment)) return { attachments: parsed.attachments };

  // The second pass over the bytes runs only for a message that carries calendar data, so
  // ordinary mail is still parsed once.
  const alternative_part_ids = await find_calendar_alternative_part_ids(mime);
  const calendar_parts = parsed.attachments
    .filter(is_calendar_attachment)
    .map((attachment) => describe_calendar_part(attachment, alternative_part_ids));
  const meeting_part = calendar_parts.find(is_meeting_part);

  const has_readable_body = Boolean(parsed.text) || typeof parsed.html === 'string';
  const meeting_content = new Set(
    has_readable_body
      ? calendar_parts
          .filter((part) => is_read_as_meeting_content(part, meeting_part))
          .map((part) => part.attachment)
      : [],
  );
  return {
    ...(meeting_part ? { meeting_part: to_meeting_calendar_part(meeting_part) } : {}),
    attachments: parsed.attachments.filter((attachment) => !meeting_content.has(attachment)),
  };
}

/** Keeps what the readers of a meeting part need: its method, charset and document. */
function to_meeting_calendar_part(part: CalendarPart & { method: string }): MeetingCalendarPart {
  const charset = read_content_type(part.attachment)?.params['charset']?.trim().toLowerCase();
  return {
    method: part.method,
    ...(charset ? { charset } : {}),
    icalendar: part.attachment.content,
  };
}

/**
 * Whether the part was sent as `text/calendar`. The header is read rather than
 * `Attachment.contentType`, which mailparser rewrites from the file name for
 * `application/octet-stream` parts, so a binary `.ics` file is not mistaken for calendar data.
 */
function is_calendar_attachment(attachment: Attachment): boolean {
  return read_content_type(attachment)?.value.toLowerCase() === CALENDAR_CONTENT_TYPE;
}

/** Reads the parsed Content-Type header of an attachment part. */
function read_content_type(attachment: Attachment): StructuredHeader | undefined {
  const header = attachment.headers.get('content-type');
  return is_structured_header(header) ? header : undefined;
}

/** Narrows a parsed header to the `value` plus `params` shape Content-Type parses to. */
function is_structured_header(header: HeaderValue | undefined): header is StructuredHeader {
  return (
    typeof header === 'object' &&
    header !== null &&
    'value' in header &&
    typeof header.value === 'string' &&
    'params' in header
  );
}

/** Collects where a calendar part sits and how it was sent. */
function describe_calendar_part(
  attachment: Attachment,
  alternative_part_ids: ReadonlySet<string>,
): CalendarPart {
  return {
    attachment,
    method: read_content_type(attachment)?.params['method']?.trim().toUpperCase(),
    is_body_alternative: attachment.partId !== null && alternative_part_ids.has(attachment.partId),
    is_declared_attachment: attachment.contentDisposition === 'attachment',
  };
}

/**
 * Whether Exchange builds the meeting item from this part. It takes the first part in document
 * order that names a meeting method, even one sent as an attachment under `multipart/mixed`. A
 * body alternative that says `Content-Disposition: attachment` is the exception: Exchange keeps
 * it as a file and delivers the message as ordinary mail.
 */
function is_meeting_part(part: CalendarPart): part is CalendarPart & { method: string } {
  if (part.method === undefined || !MEETING_METHODS.has(part.method)) return false;
  return !(part.is_body_alternative && part.is_declared_attachment);
}

/** Whether the part is calendar data Exchange reads, not a file the mailbox listed. */
function is_read_as_meeting_content(
  part: CalendarPart,
  meeting_part: CalendarPart | undefined,
): boolean {
  if (part.is_declared_attachment) return false;
  if (part.is_body_alternative) return true;
  if (part.attachment.filename || meeting_part === undefined) return false;
  return part === meeting_part || part.attachment.content.equals(meeting_part.attachment.content);
}

/**
 * Walks the MIME tree and returns the part number of every `text/calendar` child of a
 * `multipart/alternative`.
 *
 * mailparser does not say which multipart a part sits in, and that is the difference between a
 * body alternative and a calendar file under `multipart/mixed`. mailsplit is the splitter
 * mailparser itself runs, so the part numbers match `Attachment.partId`.
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
