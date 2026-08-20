import { simpleParser } from 'mailparser';
import type { AddressObject, Attachment, EmailAddress, ParsedMail } from 'mailparser';

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
  const parsed: ParsedMail = await simpleParser(mime);
  const from = flatten_addresses(parsed.from)[0];

  return {
    subject: parsed.subject ?? '',
    ...(from ? { from } : {}),
    to: flatten_addresses(parsed.to),
    cc: flatten_addresses(parsed.cc),
    ...(parsed.date ? { date: parsed.date.toISOString() } : {}),
    ...(parsed.messageId ? { message_id: parsed.messageId } : {}),
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(parsed.html ? { html: parsed.html } : {}),
    headers: flatten_header_lines(parsed),
    attachments: parsed.attachments.map(normalize_attachment),
  };
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

/** Normalizes a mailparser attachment to the shape Graph's upload port expects. */
function normalize_attachment(attachment: Attachment): MimeAttachment {
  const content_id = strip_angle_brackets(attachment.cid);
  return {
    name: attachment.filename ?? content_id ?? 'attachment',
    content_type: attachment.contentType,
    content: attachment.content,
    is_inline: attachment.contentDisposition === 'inline' || content_id !== undefined,
    ...(content_id ? { content_id } : {}),
  };
}

/** Strips the `<...>` wrapper mailparser may leave on a Content-ID. */
function strip_angle_brackets(cid: string | undefined): string | undefined {
  if (!cid) return undefined;
  return cid.replace(/^<|>$/g, '');
}
