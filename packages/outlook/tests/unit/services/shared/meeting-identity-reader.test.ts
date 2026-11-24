import { describe, it, expect } from 'vitest';
import { find_component, parse_icalendar } from '@/services/shared/icalendar-document';
import { read_meeting_identity } from '@/services/shared/meeting-identity-reader';

/** Reads the identity of a `VEVENT` holding the given content lines. */
function read_identity(event_lines: readonly string[]) {
  const document = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    ...event_lines,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const root = parse_icalendar(Buffer.from(document.join('\r\n'), 'utf-8'));
  return read_meeting_identity(find_component(find_component(root, 'VCALENDAR')!, 'VEVENT')!);
}

const UID_LINE = 'UID:meeting-4c1f@partner.example';

describe('read_meeting_identity', () => {
  it('reads the UID of a meeting', () => {
    expect(read_identity([UID_LINE])).toEqual({ uid: 'meeting-4c1f@partner.example' });
  });

  // Exchange writes this form for a message about one occurrence of a series, and its date is
  // the occurrence date in the ID Exchange stored (issue #819).
  it('reads the date of the occurrence from a local RECURRENCE-ID with a zone', () => {
    const identity = read_identity([
      UID_LINE,
      'RECURRENCE-ID;TZID=W. Europe Standard Time:20250310T090000',
    ]);

    expect(identity).toEqual({
      uid: 'meeting-4c1f@partner.example',
      occurrence_date: { year: 2025, month: 3, day: 10 },
    });
  });

  // Which date Exchange takes from these forms was not compared, so the response is restored
  // without a link to its meeting instead of with a guessed one.
  it.each([
    ['in UTC', 'RECURRENCE-ID:20250310T080000Z'],
    ['as a date', 'RECURRENCE-ID;VALUE=DATE:20250310'],
    ['as a local time with no zone', 'RECURRENCE-ID:20250310T090000'],
    ['that is not a time', 'RECURRENCE-ID;TZID=W. Europe Standard Time:someday'],
    ['on a date that does not exist', 'RECURRENCE-ID;TZID=W. Europe Standard Time:20250230T090000'],
  ])('returns nothing for a RECURRENCE-ID %s', (_label, recurrence_line) => {
    expect(read_identity([UID_LINE, recurrence_line])).toBeUndefined();
  });

  it.each([
    ['no UID', []],
    ['an empty UID', ['UID:']],
    ['a UID with a TEXT escape', ['UID:meeting\\,4c1f@partner.example']],
    ['an implausibly long UID', [`UID:${'u'.repeat(1025)}`]],
  ])('returns nothing for an event with %s', (_label, event_lines) => {
    expect(read_identity(event_lines)).toBeUndefined();
  });
});
