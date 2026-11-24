import { describe, it, expect } from 'vitest';
import { parse_mime_message } from '@/services/shared/mime-message-parser';
import { read_meeting_response } from '@/services/shared/meeting-response-reader';
import {
  HTML_BODY_PART,
  PLAIN_BODY_PART,
  build_flat_mixed_mime,
  build_icalendar,
  build_mixed_meeting_mime,
  calendar_file_part,
  calendar_part,
} from './meeting-message-mime.fixtures';

/** Reads the response of a REPLY whose ATTENDEE lines are the ones given. */
function read_reply(attendee_lines: readonly string[]) {
  const icalendar = build_icalendar('REPLY', { attendee_lines });
  return read_meeting_response({ method: 'REPLY', icalendar: Buffer.from(icalendar, 'utf-8') });
}

const ATTENDEE = 'mailto:jane.roe@partner.example';

// The mapping is what Exchange Online gave each of these replies when it built the meeting
// response: IPM.Schedule.Meeting.Resp.Pos, .Neg or .Tent (issue #817).
describe('read_meeting_response', () => {
  it.each([
    ['ACCEPTED', 'accepted'],
    ['DECLINED', 'declined'],
    ['TENTATIVE', 'tentative'],
    ['NEEDS-ACTION', 'tentative'],
    ['DELEGATED', 'tentative'],
  ])('maps a reply with PARTSTAT=%s to %s', (partstat, expected) => {
    expect(read_reply([`ATTENDEE;PARTSTAT=${partstat}:${ATTENDEE}`])).toBe(expected);
  });

  it('treats a reply whose attendee has no PARTSTAT as tentative', () => {
    expect(read_reply([`ATTENDEE;CN=Jane Roe:${ATTENDEE}`])).toBe('tentative');
  });

  it('takes the first attendee when a reply lists several', () => {
    const declined_first = [
      `ATTENDEE;PARTSTAT=DECLINED:${ATTENDEE}`,
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:other.guest@partner.example',
    ];

    expect(read_reply(declined_first)).toBe('declined');
  });

  it('reads a lower-case PARTSTAT from a folded line', () => {
    const folded = [
      'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;CN=Jane Roe;partstat=',
      ` declined;X-NUM-GUESTS=0:${ATTENDEE}`,
    ];

    expect(read_reply(folded)).toBe('declined');
  });

  it('is not misled by separators inside a quoted parameter value', () => {
    const quoted = [`ATTENDEE;CN="Roe; Jane: PARTSTAT=DECLINED";PARTSTAT=ACCEPTED:${ATTENDEE}`];

    expect(read_reply(quoted)).toBe('accepted');
  });

  it('returns nothing for a reply with no attendee', () => {
    expect(read_reply([])).toBeUndefined();
  });

  it('treats a counter proposal as tentative', () => {
    const icalendar = Buffer.from(build_icalendar('COUNTER'), 'utf-8');

    expect(read_meeting_response({ method: 'COUNTER', icalendar })).toBe('tentative');
  });

  it.each(['REQUEST', 'CANCEL'])('returns nothing for a %s', (method) => {
    const icalendar = Buffer.from(build_icalendar(method), 'utf-8');

    expect(read_meeting_response({ method, icalendar })).toBeUndefined();
  });
});

describe('the meeting response of a parsed message', () => {
  it('is read from the calendar alternative', async () => {
    const parsed = await parse_mime_message(
      build_mixed_meeting_mime([PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REPLY')], []),
    );

    expect(parsed.meeting_response).toBe('accepted');
  });

  it('is read from a reply sent as a named attachment under multipart/mixed', async () => {
    const parsed = await parse_mime_message(
      build_flat_mixed_mime([
        PLAIN_BODY_PART,
        calendar_file_part('reply.ics', '; method=REPLY', build_icalendar('REPLY')),
      ]),
    );

    expect(parsed.meeting_response).toBe('accepted');
  });

  // Exchange delivers these as ordinary mail, so they must not come back as meeting responses.
  it.each([
    [
      'a calendar alternative that says Content-Disposition: attachment',
      build_mixed_meeting_mime(
        [
          PLAIN_BODY_PART,
          HTML_BODY_PART,
          calendar_part('REPLY', ['Content-Disposition: attachment; filename="reply.ics"']),
        ],
        [],
      ),
    ],
    [
      'a calendar file with no method parameter',
      build_flat_mixed_mime([
        PLAIN_BODY_PART,
        calendar_file_part('reply.ics', '', build_icalendar('REPLY')),
      ]),
    ],
    [
      'a meeting request',
      build_mixed_meeting_mime([PLAIN_BODY_PART, HTML_BODY_PART, calendar_part('REQUEST')], []),
    ],
    ['a message with no calendar data', build_flat_mixed_mime([PLAIN_BODY_PART])],
  ])('is absent on %s', async (_label, mime) => {
    const parsed = await parse_mime_message(mime);

    expect(parsed.meeting_response).toBeUndefined();
  });
});
