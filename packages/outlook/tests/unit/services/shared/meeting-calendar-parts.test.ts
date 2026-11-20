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
  build_icalendar,
  build_mixed_meeting_mime,
  calendar_file_part,
  calendar_part,
} from './meeting-message-mime.fixtures';

/** Name and content type of each attachment, which is what restore uploads them under. */
function describe_attachments(attachments: readonly MimeAttachment[]): string[] {
  return attachments.map((attachment) => `${attachment.name} (${attachment.content_type})`);
}

const BODY_ALTERNATIVES = [PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REPLY')];
const OTHER_MEETING_ICALENDAR = build_icalendar('REPLY', { uid: 'other-99aa@partner.example' });

// A meeting response carries its iCalendar data as a third body alternative. Exchange builds the
// meeting item from that part, so the source message shows `invite.ics` alone. Restore used to
// upload the alternative as a second file named `attachment` (issue #817).
describe('the calendar alternative of a meeting message', () => {
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

  // PUBLISH makes no meeting item, and Exchange still does not list the alternative.
  it.each(['REQUEST', 'REPLY', 'CANCEL', 'PUBLISH'])('is dropped for METHOD:%s', async (method) => {
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

  it('stays an attachment when it says Content-Disposition: attachment', async () => {
    const declared_attachment = calendar_part('REPLY', [
      'Content-Disposition: attachment; filename="reply.ics"',
    ]);
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime([PLAIN_BODY_PART, HTML_BODY_PART, declared_attachment], []),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['reply.ics (text/calendar)']);
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

// Exchange also builds a meeting item from a calendar part outside the body, and lists neither
// that part nor an exact copy of it. Only the nameless ones are dropped: they are the parts
// restore would otherwise upload under the made-up name `attachment`.
describe('a nameless calendar part outside the body', () => {
  it('is dropped when the meeting item is built from it', async () => {
    const parsed = await parse_mime_message(
      build_flat_mixed_mime([PLAIN_BODY_PART, calendar_part('REQUEST')]),
    );

    expect(parsed.attachments).toEqual([]);
  });

  it('is dropped when it copies the calendar alternative byte for byte', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(BODY_ALTERNATIVES, [INVITE_ICS_PART, calendar_part('REPLY')]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['invite.ics (application/ics)']);
  });

  it('stays an attachment when it describes another meeting', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(BODY_ALTERNATIVES, [
        calendar_part('REPLY', [], OTHER_MEETING_ICALENDAR),
      ]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['attachment (text/calendar)']);
  });

  it('stays an attachment when it names no meeting method', async () => {
    const parsed = await parse_mime_message(
      build_flat_mixed_mime([PLAIN_BODY_PART, calendar_part('PUBLISH')]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['attachment (text/calendar)']);
  });
});

// A calendar file sent under a name is restored whatever Exchange made of it. Exchange hides some
// of these as well, but a named file is content the sender attached, and dropping it loses it.
describe('a named calendar file', () => {
  it('is kept beside the calendar alternative it copies', async () => {
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

  it('is kept when the meeting item is built from it', async () => {
    const parsed = await parse_mime_message(
      build_flat_mixed_mime([
        PLAIN_BODY_PART,
        calendar_file_part('invite.ics', '; method=REQUEST', build_icalendar('REQUEST')),
      ]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['invite.ics (text/calendar)']);
  });

  it('is kept in an ordinary message that carries .ics files', async () => {
    const parsed = await parse_mime_message(
      build_flat_mixed_mime([
        PLAIN_BODY_PART,
        INVITE_ICS_PART,
        calendar_file_part('event.ics', '', build_icalendar('PUBLISH')),
      ]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual([
      'invite.ics (application/ics)',
      'event.ics (text/calendar)',
    ]);
  });

  // The forwarded message is one attachment, and its own calendar alternative travels inside it.
  it('is kept inside an attached message, which keeps its bytes', async () => {
    const forwarded = build_alternative_only_meeting_mime([
      PLAIN_BODY_PART,
      HTML_BODY_PART,
      calendar_part('REQUEST'),
    ]);
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime(BODY_ALTERNATIVES, [
        {
          headers: [
            'Content-Type: message/rfc822',
            'Content-Disposition: attachment; filename="forwarded.eml"',
          ],
          body: forwarded.toString('utf-8'),
        },
      ]),
    );

    expect(describe_attachments(parsed.attachments)).toEqual(['forwarded.eml (message/rfc822)']);
    expect(parsed.attachments[0]?.content.toString('utf-8')).toContain('METHOD:REQUEST');
  });
});
