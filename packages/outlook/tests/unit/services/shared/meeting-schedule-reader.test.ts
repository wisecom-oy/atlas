import { describe, it, expect } from 'vitest';
import { read_meeting_schedule } from '@/services/shared/meeting-schedule-reader';
import type { MeetingSchedule } from '@/services/shared/meeting-schedule-reader';
import {
  PACIFIC_ZONE,
  SYDNEY_ZONE,
  WEST_EUROPE_ZONE,
  build_schedule_icalendar,
  zone_lines,
} from './icalendar-time-zone.fixtures';
import type { ScheduleIcalendarOptions } from './icalendar-time-zone.fixtures';

/** Reads the schedule of a reply built from the given zone blocks and event lines. */
function read_schedule(
  options: ScheduleIcalendarOptions,
  charset?: string,
): MeetingSchedule | undefined {
  const icalendar = Buffer.from(build_schedule_icalendar(options), 'utf-8');
  return read_meeting_schedule({ method: 'REPLY', ...(charset ? { charset } : {}), icalendar });
}

const WEST_EUROPE_TZID = ';TZID=W. Europe Standard Time';
const UTC_TIME_LINES = ['DTSTART:20240710T090000Z', 'DTEND:20240710T093000Z'];
/** The identity of the meeting every fixture document is about. */
const MEETING_IDENTITY = { uid: 'meeting-4c1f@partner.example' };

// The expected instants are what Exchange Online reported for a response carrying the same
// calendar part (issue #819).
describe('the meeting time of a calendar part', () => {
  it('reads UTC times as they are', () => {
    expect(read_schedule({ event_lines: UTC_TIME_LINES })?.time).toEqual({
      start: '2024-07-10T09:00:00.000Z',
      end: '2024-07-10T09:30:00.000Z',
      is_all_day: false,
    });
  });

  it('converts local times through the zone block the document carries', () => {
    const schedule = read_schedule({
      zones: [WEST_EUROPE_ZONE],
      event_lines: [
        `DTSTART${WEST_EUROPE_TZID}:20240115T100000`,
        `DTEND${WEST_EUROPE_TZID}:20240115T110000`,
      ],
    });

    expect(schedule?.time).toEqual({
      start: '2024-01-15T09:00:00.000Z',
      end: '2024-01-15T10:00:00.000Z',
      is_all_day: false,
    });
  });

  it('matches a quoted zone id to its block', () => {
    const schedule = read_schedule({
      zones: [WEST_EUROPE_ZONE],
      event_lines: [
        'DTSTART;TZID="W. Europe Standard Time":20240715T100000',
        'DTEND;TZID="W. Europe Standard Time":20240715T110000',
      ],
    });

    expect(schedule?.time?.start).toBe('2024-07-15T08:00:00.000Z');
  });

  it('resolves start and end in different zones, each through its own block', () => {
    const schedule = read_schedule({
      zones: [WEST_EUROPE_ZONE, PACIFIC_ZONE],
      event_lines: [
        `DTSTART${WEST_EUROPE_TZID}:20240715T180000`,
        'DTEND;TZID=Pacific Standard Time:20240715T100000',
      ],
    });

    expect(schedule?.time).toEqual({
      start: '2024-07-15T16:00:00.000Z',
      end: '2024-07-15T17:00:00.000Z',
      is_all_day: false,
    });
  });

  // A wrong time on a restored item is worse than none. Exchange resolves some of these by
  // looking a zone name up or by assuming UTC, and Atlas does not guess along.
  it.each([
    [
      'a zone id with no block in the document',
      { event_lines: [`DTSTART${WEST_EUROPE_TZID}:20240715T100000`, 'DTEND:20240715T110000Z'] },
    ],
    [
      'a zone block for another zone only',
      {
        zones: [PACIFIC_ZONE],
        event_lines: [
          `DTSTART${WEST_EUROPE_TZID}:20240715T100000`,
          `DTEND${WEST_EUROPE_TZID}:20240715T110000`,
        ],
      },
    ],
    ['floating local times', { event_lines: ['DTSTART:20240715T100000', 'DTEND:20240715T110000'] }],
    [
      'a DURATION in place of DTEND',
      { event_lines: ['DTSTART:20240710T090000Z', 'DURATION:PT45M'] },
    ],
    ['no end at all', { event_lines: ['DTSTART:20240710T090000Z'] }],
    ['no start', { event_lines: ['DTEND:20240710T093000Z'] }],
    [
      'an end before the start',
      { event_lines: ['DTSTART:20240710T090000Z', 'DTEND:20240710T080000Z'] },
    ],
    [
      'a date start with a timed end',
      { event_lines: ['DTSTART;VALUE=DATE:20240715', 'DTEND:20240716T000000Z'] },
    ],
    ['a start that is not a date', { event_lines: ['DTSTART:tomorrow', 'DTEND:20240710T093000Z'] }],
    ['a year before 1601', { event_lines: ['DTSTART:15000710T090000Z', 'DTEND:15000710T093000Z'] }],
    [
      'a zone rule the code does not model',
      {
        zones: [
          zone_lines('Until Zone', {
            dtstart: '20071104T020000',
            from: '-0400',
            to: '-0500',
            rrule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;UNTIL=20301103T060000Z',
          }),
        ],
        event_lines: [
          'DTSTART;TZID=Until Zone:20240715T100000',
          'DTEND;TZID=Until Zone:20240715T110000',
        ],
      },
    ],
  ])('leaves the time out for %s', (_label, options) => {
    expect(read_schedule(options)?.time).toBeUndefined();
  });
});

// A date names no zone. Exchange places it at midnight in the document's only zone block, and at
// midnight UTC when the document has no block or more than one.
describe('the meeting time of an all-day calendar part', () => {
  const ALL_DAY_LINES = ['DTSTART;VALUE=DATE:20240715', 'DTEND;VALUE=DATE:20240716'];

  it('starts the day at midnight in the only zone block, west of UTC', () => {
    expect(read_schedule({ zones: [PACIFIC_ZONE], event_lines: ALL_DAY_LINES })?.time).toEqual({
      start: '2024-07-15T07:00:00.000Z',
      end: '2024-07-16T07:00:00.000Z',
      is_all_day: true,
    });
  });

  it('starts the day at midnight in the only zone block, east of UTC', () => {
    expect(read_schedule({ zones: [SYDNEY_ZONE], event_lines: ALL_DAY_LINES })?.time).toEqual({
      start: '2024-07-14T14:00:00.000Z',
      end: '2024-07-15T14:00:00.000Z',
      is_all_day: true,
    });
  });

  it.each([
    ['no zone block', []],
    ['two zone blocks', [PACIFIC_ZONE, SYDNEY_ZONE]],
  ])('starts the day at midnight UTC with %s', (_label, zones) => {
    expect(read_schedule({ zones, event_lines: ALL_DAY_LINES })?.time).toEqual({
      start: '2024-07-15T00:00:00.000Z',
      end: '2024-07-16T00:00:00.000Z',
      is_all_day: true,
    });
  });

  it('reads a bare date with no VALUE parameter as all-day', () => {
    const schedule = read_schedule({ event_lines: ['DTSTART:20240715', 'DTEND:20240716'] });

    expect(schedule?.time?.is_all_day).toBe(true);
  });

  it('leaves the time out when the only zone block cannot be modelled', () => {
    const unmodelled = zone_lines('Odd Offset', {
      dtstart: '16010101T000000',
      from: 'CET',
      to: 'CET',
    });

    expect(
      read_schedule({ zones: [unmodelled], event_lines: ALL_DAY_LINES })?.time,
    ).toBeUndefined();
  });
});

describe('the meeting location of a calendar part', () => {
  /** Reads the location of a reply whose event carries this LOCATION line. */
  function read_location(location_line: string, charset?: string): string | undefined {
    return read_schedule({ event_lines: [...UTC_TIME_LINES, location_line] }, charset)?.location;
  }

  it('reads a plain location, with or without a LANGUAGE parameter', () => {
    expect(read_location('LOCATION:Room 1')).toBe('Room 1');
    expect(read_location('LOCATION;LANGUAGE=en-US:Room with a view')).toBe('Room with a view');
  });

  it('undoes TEXT escaping, with a line break as the CRLF Exchange stores', () => {
    expect(read_location('LOCATION:Building A\\, Room 2\; floor 3\\nSecond line\\\\')).toBe(
      'Building A, Room 2; floor 3\r\nSecond line\\',
    );
  });

  it('keeps a location longer than a room name', () => {
    expect(read_location(`LOCATION:${'L'.repeat(300)}`)).toBe('L'.repeat(300));
  });

  it.each([
    ['empty', 'LOCATION:'],
    ['blank', 'LOCATION:   '],
    ['implausibly long', `LOCATION:${'L'.repeat(1025)}`],
  ])('leaves out a location that is %s', (_label, location_line) => {
    expect(read_location(location_line)).toBeUndefined();
  });

  it('reads the location when the part says its charset is UTF-8 or ASCII', () => {
    expect(read_location('LOCATION:Sali Äänekoski', 'utf-8')).toBe('Sali Äänekoski');
    expect(read_location('LOCATION:Room 1', 'us-ascii')).toBe('Room 1');
  });

  // The bytes are decoded as UTF-8, so text in another charset would be restored garbled.
  it('leaves the location out for any other charset, and still reads the time', () => {
    const schedule = read_schedule(
      { event_lines: [...UTC_TIME_LINES, 'LOCATION:Room 1'] },
      'iso-8859-1',
    );

    expect(schedule).toEqual({
      time: {
        start: '2024-07-10T09:00:00.000Z',
        end: '2024-07-10T09:30:00.000Z',
        is_all_day: false,
      },
    });
  });
});

describe('read_meeting_schedule', () => {
  it('returns a location alone when the time cannot be read', () => {
    const schedule = read_schedule({ event_lines: ['DTSTART:20240715T100000', 'LOCATION:Room 1'] });

    expect(schedule).toEqual({ location: 'Room 1', identity: MEETING_IDENTITY });
  });

  it('returns the identity alone when the event has neither a readable time nor a location', () => {
    expect(read_schedule({ event_lines: [] })).toEqual({ identity: MEETING_IDENTITY });
  });

  // The UID is text like the location, and the bytes are decoded as UTF-8 whatever the part says.
  it('leaves the identity out when the part declares another charset', () => {
    expect(read_schedule({ event_lines: [] }, 'iso-8859-1')).toBeUndefined();
  });

  it('returns nothing for a part that is not an iCalendar document', () => {
    const icalendar = Buffer.from('this is not an icalendar document', 'utf-8');

    expect(read_meeting_schedule({ method: 'REPLY', icalendar })).toBeUndefined();
  });
});
