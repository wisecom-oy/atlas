import { describe, it, expect } from 'vitest';
import { parse_mime_message } from '@/services/shared/mime-message-parser';
import type { MimeAttachment } from '@/services/shared/mime-message-parser';
import {
  HTML_BODY_PART,
  INVITE_ICS_PART,
  NAMED_CALENDAR_ATTACHMENT_PART,
  PLAIN_BODY_PART,
  REPLY_ICALENDAR,
  build_alternative_only_meeting_mime,
  build_flat_mixed_mime,
  build_mixed_meeting_mime,
  calendar_part,
} from './meeting-message-mime.fixtures';

/** Name and content type of each attachment, which is what restore uploads them under. */
function describe_attachments(attachments: readonly MimeAttachment[]): string[] {
  return attachments.map((attachment) => `${attachment.name} (${attachment.content_type})`);
}

// A meeting response carries its iCalendar data as a third body alternative. Exchange reads that
// part into the meeting properties, so the source message shows `invite.ics` alone. Restore used to
// upload the alternative as a second file named `attachment` (issue #817).
describe('the calendar alternative of a meeting message', () => {
  const BODY_ALTERNATIVES = [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REPLY')];

  it('is not an attachment, while invite.ics keeps its name and bytes', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(BODY_ALTERNATIVES, [INVITE_ICS_PART]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['invite.ics (application/ics)']);
    expect(parsed.attachments[0]?.is_inline).toBe(false);
    expect(parsed.attachments[0]?.content.toString('utf-8')).toBe(REPLY_ICALENDAR);
  });

  it('leaves the plain and HTML body as they were', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(BODY_ALTERNATIVES, [INVITE_ICS_PART]),
    );

    expect(parsed.text?.trim()).toBe('Jane Roe has accepted this invitation.');
    expect(parsed.html).toContain('<p>Jane Roe has accepted this invitation.</p>');
  });

  it.each(['REQUEST', 'REPLY', 'CANCEL'])('is dropped for a METHOD:%s message', async (method) => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(
        [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part(method)],
        [INVITE_ICS_PART],
      ),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['invite.ics (application/ics)']);
  });

  it('is dropped when the message is the multipart/alternative alone', async () => {
    const parsed = await parse_mime_message(build_alternative_only_meeting_mime(BODY_ALTERNATIVES));

    expect(parsed.attachments).toEqual([]);
  });

  it('keeps a named text/calendar attachment sent beside it', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(BODY_ALTERNATIVES, [
        INVITE_ICS_PART,
        NAMED_CALENDAR_ATTACHMENT_PART,
      ]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual([
      'invite.ics (application/ics)',
      'reply.ics (text/calendar)',
    ]);
  });
});

// Only a child of multipart/alternative is another rendering of the body. Anywhere else, and
// whenever the part asks to be an attachment, the calendar data is a file the message carries, and
// dropping it would lose content the mailbox showed.
describe('a text/calendar part that is not a body alternative', () => {
  it('stays an attachment directly under multipart/mixed, even with no disposition', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(
        [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REPLY')],
        [INVITE_ICS_PART, calendar_part('REPLY')],
      ),
    );

    expect(describe_attachments(parsed.attachments)).toEqual([
      'invite.ics (application/ics)',
      'attachment (text/calendar)',
    ]);
  });

  it('stays an attachment in an ordinary message that carries .ics files', async () => {
    const parsed = await parse_mime_message(
      build_flat_mixed_mime([PLAIN_BODY_PART, INVITE_ICS_PART, NAMED_CALENDAR_ATTACHMENT_PART]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual([
      'invite.ics (application/ics)',
      'reply.ics (text/calendar)',
    ]);
  });

  it('stays an attachment inside multipart/alternative when it says so', async () => {
    const declared_attachment = calendar_part('REPLY', [
      'Content-Disposition: attachment; filename="reply.ics"',
    ]);
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime([PLAIN_BODY_PART, HTML_BODY_PART, declared_attachment], []),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['reply.ics (text/calendar)']);
  });

  // The forwarded message is one attachment, and its own calendar alternative travels inside it.
  it('stays inside an attached message, which keeps its bytes', async () => {
    const forwarded = build_alternative_only_meeting_mime([
      PLAIN_BODY_PART,
      HTML_BODY_PART,
      calendar_part('REQUEST'),
    ]);
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(
        [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REPLY')],
        [
          {
            headers: [
              'Content-Type: message/rfc822',
              'Content-Disposition: attachment; filename="forwarded.eml"',
            ],
            body: forwarded.toString('utf-8'),
          },
        ],
      ),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['forwarded.eml (message/rfc822)']);
    expect(parsed.attachments[0]?.content.toString('utf-8')).toContain('METHOD:REQUEST');
  });

  // With no plain or HTML alternative the calendar part is the only copy of what the message
  // shows, so it is kept rather than restoring an empty message.
  it('stays an attachment when it is the only body the message has', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime([calendar_part('REQUEST')], [INVITE_ICS_PART]),
    );

    expect(parsed.text).toBeUndefined();
    expect(parsed.html).toBeUndefined();
    expect(describe_attachments(parsed.attachments)).toEqual([
      'attachment (text/calendar)',
      'invite.ics (application/ics)',
    ]);
  });
});
