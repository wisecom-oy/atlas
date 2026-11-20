/** MIME parts and whole messages shaped like the meeting mail Exchange serves from `/$value`. */

/** One MIME part: its header lines and its already encoded body. */
export interface MimePart {
  readonly headers: readonly string[];
  readonly body: string;
}

/** Builds the iCalendar document a meeting message carries for the given iTIP method. */
export function build_icalendar(method: string): string {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Example Corp//Calendar//EN',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'DTSTART:20250310T090000Z',
    'DTEND:20250310T093000Z',
    'UID:meeting-4c1f@partner.example',
    'ORGANIZER:mailto:john.doe@example.com',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:jane.roe@partner.example',
    'SUMMARY:Example subject',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

export const REPLY_ICALENDAR = build_icalendar('REPLY');

export const PLAIN_BODY_PART: MimePart = {
  headers: ['Content-Type: text/plain; charset="UTF-8"'],
  body: 'Jane Roe has accepted this invitation.',
};

export const HTML_BODY_PART: MimePart = {
  headers: ['Content-Type: text/html; charset="UTF-8"'],
  body: '<html><body><p>Jane Roe has accepted this invitation.</p></body></html>',
};

/** The inline calendar part: no Content-Disposition and no name, as the sending calendar wrote it. */
export function calendar_part(method: string, extra_headers: readonly string[] = []): MimePart {
  return {
    headers: [
      `Content-Type: text/calendar; charset="UTF-8"; method=${method}`,
      'Content-Transfer-Encoding: 7bit',
      ...extra_headers,
    ],
    body: build_icalendar(method),
  };
}

/** The `invite.ics` file Google Calendar attaches beside the inline calendar part. */
export const INVITE_ICS_PART: MimePart = {
  headers: [
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Transfer-Encoding: base64',
  ],
  body: Buffer.from(REPLY_ICALENDAR, 'utf-8').toString('base64'),
};

/** A `text/calendar` file sent as a real attachment, with its own name. */
export const NAMED_CALENDAR_ATTACHMENT_PART: MimePart = {
  headers: [
    'Content-Type: text/calendar; charset="UTF-8"; method=REPLY; name="reply.ics"',
    'Content-Disposition: attachment; filename="reply.ics"',
    'Content-Transfer-Encoding: 7bit',
  ],
  body: REPLY_ICALENDAR,
};

const MESSAGE_HEADERS = [
  'From: "Jane Roe" <jane.roe@partner.example>',
  'To: "John Doe" <john.doe@example.com>',
  'Subject: Accepted: Example subject',
  'Date: Mon, 3 Mar 2025 08:00:00 +0000',
  'Message-ID: <calendar-reply-7d20@partner.example>',
  'MIME-Version: 1.0',
];

/** Renders the parts of one multipart entity, boundary lines included. */
function render_multipart(boundary: string, parts: readonly (MimePart | string)[]): string {
  const rendered = parts.map((part) =>
    typeof part === 'string' ? part : [...part.headers, '', part.body].join('\r\n'),
  );
  return [...rendered.map((part) => `--${boundary}\r\n${part}\r\n`), `--${boundary}--`, ''].join(
    '\r\n',
  );
}

/** Renders a `multipart/alternative` entity, for nesting under `multipart/mixed`. */
function render_alternative_entity(alternatives: readonly MimePart[]): string {
  return [
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    render_multipart('ALT', alternatives),
  ].join('\r\n');
}

/**
 * A `multipart/mixed` message: the body alternatives first, then the parts beside them. This is
 * the shape of the "Accepted:" response in issue #817.
 */
export function build_mixed_meeting_mime(
  alternatives: readonly MimePart[],
  mixed_parts: readonly MimePart[],
): Buffer {
  return Buffer.from(
    [
      ...MESSAGE_HEADERS,
      'Content-Type: multipart/mixed; boundary="MIX"',
      '',
      render_multipart('MIX', [render_alternative_entity(alternatives), ...mixed_parts]),
    ].join('\r\n'),
    'utf-8',
  );
}

/** A message whose root entity is the `multipart/alternative` itself, with no attachments. */
export function build_alternative_only_meeting_mime(alternatives: readonly MimePart[]): Buffer {
  return Buffer.from([...MESSAGE_HEADERS, render_alternative_entity(alternatives)].join('\r\n'));
}

/** A `multipart/mixed` message with no `multipart/alternative`: every part is a direct child. */
export function build_flat_mixed_mime(parts: readonly MimePart[]): Buffer {
  return Buffer.from(
    [
      ...MESSAGE_HEADERS,
      'Content-Type: multipart/mixed; boundary="MIX"',
      '',
      render_multipart('MIX', parts),
    ].join('\r\n'),
    'utf-8',
  );
}
