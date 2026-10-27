import { simpleParser } from 'mailparser';
import type { AddressObject, Attachment, EmailAddress, ParsedMail } from 'mailparser';
import { UnreadableContentError } from '@wisecom/atlas-types';

export interface MimeAddress {
  readonly name: string;
  readonly address: string;
}

export interface MimeHeader {
  readonly name: string;
  readonly value: string;
}

export interface MimeAttachment {
  readonly name: string;
  readonly content_type: string;
  readonly content: Buffer;
  readonly is_inline: boolean;
  readonly content_id?: string;
}

export interface ParsedMimeMessage {
  readonly subject: string;
  readonly from?: MimeAddress;
  readonly to: MimeAddress[];
  readonly cc: MimeAddress[];
  readonly date?: string;
  readonly message_id?: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers: MimeHeader[];
  readonly attachments: MimeAttachment[];
}

/** Parses RFC 5322 MIME bytes into the fields Atlas needs for restore and display. */
export async function parse_mime_message(mime: Buffer): Promise<ParsedMimeMessage> {
  // cid: links are kept so the attachments the body references can be identified, then inlined
  // as data: URIs below exactly as simpleParser does by default (issue #474).
  const parsed: ParsedMail = await simpleParser(mime, { keepCidLinks: true });
  assert_header_block_parsed(parsed, mime);
  const from = flatten_addresses(parsed.from)[0];
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  const referenced_cids = new Set([...(html ?? '').matchAll(CID_LINK)].map((m) => m[1]!));

  return {
    subject: parsed.subject ?? '',
    ...(from ? { from } : {}),
    to: flatten_addresses(parsed.to),
    cc: flatten_addresses(parsed.cc),
    ...(parsed.date ? { date: parsed.date.toISOString() } : {}),
    ...(parsed.messageId ? { message_id: parsed.messageId } : {}),
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(html ? { html: inline_cid_images(html, parsed.attachments) } : {}),
    headers: flatten_header_lines(parsed),
    attachments: parsed.attachments.map((a) => normalize_attachment(a, referenced_cids)),
  };
}

const CID_LINK = /\bcid:([^'"\s]{1,256})/g;

/** Replaces `cid:` links to image attachments with data: URIs, as simpleParser does by default. */
function inline_cid_images(html: string, attachments: Attachment[]): string {
  return html.replace(CID_LINK, (link, cid: string) => {
    const image = attachments.find((a) => a.cid === cid && /^image\/\w+$/i.test(a.contentType));
    return image ? `data:${image.contentType};base64,${image.content.toString('base64')}` : link;
  });
}

export interface MimeEnvelope {
  readonly subject?: string;
  readonly from?: MimeAddress;
  readonly date?: Date;
}

/** Reads Subject, From and Date from the header block alone, without decoding body parts. */
export async function parse_mime_envelope(mime: Buffer): Promise<MimeEnvelope> {
  const parsed: ParsedMail = await simpleParser(slice_header_block(mime));
  const from = flatten_addresses(parsed.from)[0];
  const date = read_date_header(parsed);
  return {
    ...(parsed.subject ? { subject: parsed.subject } : {}),
    ...(from ? { from } : {}),
    ...(date ? { date } : {}),
  };
}

/** Returns the bytes before the first blank line, which RFC 5322 defines as the header block. */
function slice_header_block(mime: Buffer): Buffer {
  const ends = [mime.indexOf('\r\n\r\n'), mime.indexOf('\n\n')].filter((at) => at >= 0);
  return ends.length === 0 ? mime : mime.subarray(0, Math.min(...ends));
}

/**
 * Parses the raw Date header. `parsed.date` is not used because mailparser substitutes the
 * current time for an unparseable Date, and a parse time must never pass as a receive time.
 */
function read_date_header(parsed: ParsedMail): Date | undefined {
  const header = (parsed.headerLines ?? []).find(({ key }) => key === 'date');
  if (!header) return undefined;
  const date = new Date(unfold_header_value(header.line.slice(header.line.indexOf(':') + 1)));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Rejects a message whose header block mailsplit refused to parse.
 *
 * Past its 1 MiB `MAX_HEAD_SIZE` (`@zone-eu/mailsplit/lib/message-splitter.js`), mailsplit
 * abandons the block and `simpleParser` returns no `headerLines`, no `headers`, no addresses and
 * no subject. `flatten_header_lines` then read `.map` off `undefined` and the restore reported
 * `TypeError: Cannot read properties of undefined (reading 'map')` next to a message id, which
 * told an operator nothing about the cause (issue #411).
 *
 * Failing is the deliberate answer rather than restoring what did parse. Every address, the
 * subject, the date and every header line are gone, so a body-only restore would put a message
 * in the mailbox that is not the one that was backed up, and it would look like a success. The
 * restore already isolates a failed entry and carries on with the rest, so the cost of failing
 * is one reported message rather than the run.
 *
 * Only the size cap produces this: an empty buffer, a garbage buffer and a body-only message all
 * still parse to one header line.
 */
function assert_header_block_parsed(parsed: ParsedMail, mime: Buffer): void {
  if (parsed.headerLines !== undefined) return;
  throw new UnreadableContentError(
    `The message header block exceeds the 1 MiB limit the MIME parser enforces, so none of the ` +
      `headers could be read (message size ${mime.length} bytes). The message is stored and ` +
      `intact; it cannot be restored, because its addresses, subject and headers are ` +
      `unreadable. Extract the raw bytes with \`atlas outlook save\` to recover its content.`,
  );
}

/**
 * Flattens mailparser's address containers into `{ name, address }` pairs.
 * A header may parse to one container or several (repeated To/Cc headers),
 * and group addresses nest their members under `group`.
 */
function flatten_addresses(source: AddressObject | AddressObject[] | undefined): MimeAddress[] {
  if (!source) return [];
  const containers = Array.isArray(source) ? source : [source];
  return containers.flatMap((container) => container.value.flatMap(expand_address));
}

/** Expands one parsed address, recursing into group members. */
function expand_address(entry: EmailAddress): MimeAddress[] {
  if (entry.group) return entry.group.flatMap(expand_address);
  if (!entry.address) return [];
  return [{ name: entry.name ?? '', address: entry.address }];
}

/**
 * Converts raw header lines into a flat name/value list, preserving order and
 * duplicates. `headerLines` is used instead of the collapsed `headers` map
 * because chains like Received appear multiple times and must all survive.
 */
function flatten_header_lines(parsed: ParsedMail): MimeHeader[] {
  return parsed.headerLines.map(({ line }) => {
    const separator = line.indexOf(':');
    if (separator === -1) return { name: line.trim(), value: '' };
    return {
      name: line.slice(0, separator).trim(),
      value: unfold_header_value(line.slice(separator + 1)),
    };
  });
}

/** Joins the continuation lines of a folded header into a single spaced value. */
function unfold_header_value(value: string): string {
  return value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Normalizes a mailparser attachment to the shape Graph's upload port expects.
 *
 * Exchange puts a Content-ID on ordinary `Content-Disposition: attachment` parts, so a Content-ID
 * alone does not make a part inline: uploaded as inline, Outlook hides it because the body never
 * shows it. Inline means the part says so, or it has no disposition and the body references its
 * Content-ID (issue #474).
 */
function normalize_attachment(
  attachment: Attachment,
  referenced_cids: Set<string>,
): MimeAttachment {
  const content_id = strip_angle_brackets(attachment.cid);
  const disposition = attachment.contentDisposition;
  return {
    name: attachment.filename ?? content_id ?? 'attachment',
    content_type: attachment.contentType,
    content: attachment.content,
    is_inline:
      disposition === 'inline' ||
      (disposition !== 'attachment' && content_id !== undefined && referenced_cids.has(content_id)),
    ...(content_id ? { content_id } : {}),
  };
}

/** Strips the `<...>` wrapper mailparser may leave on a Content-ID. */
function strip_angle_brackets(cid: string | undefined): string | undefined {
  if (!cid) return undefined;
  return cid.replace(/^<|>$/g, '');
}
