import { describe, it, expect } from 'vitest';
import { find_component, parse_icalendar } from '@/services/shared/icalendar-document';
import {
  convert_zone_local_time_to_utc,
  parse_local_date_time,
} from '@/services/shared/icalendar-time-zone';
import {
  BERLIN_ZONE,
  INDIA_ZONE,
  PACIFIC_ZONE,
  SYDNEY_ZONE,
  WEST_EUROPE_ZONE,
  zone_lines,
} from './icalendar-time-zone.fixtures';

/** Converts a wall-clock time in the zone the block describes to an ISO 8601 UTC instant. */
function to_utc(zone: readonly string[], local: string): string | undefined {
  const document = Buffer.from(zone.join('\r\n'), 'utf-8');
  const component = find_component(parse_icalendar(document), 'VTIMEZONE')!;
  const utc_ms = convert_zone_local_time_to_utc(component, parse_local_date_time(local)!);
  return utc_ms === undefined ? undefined : new Date(utc_ms).toISOString();
}

// Every expected instant below is what Exchange Online reported for a meeting message carrying
// the same block and the same local time (issue #819).
describe('convert_zone_local_time_to_utc', () => {
  it.each([
    ['winter', '20240115T100000', '2024-01-15T09:00:00.000Z'],
    ['summer', '20240715T100000', '2024-07-15T08:00:00.000Z'],
    ['the day clocks go forward, before the change', '20240331T010000', '2024-03-31T00:00:00.000Z'],
    ['the day clocks go forward, after the change', '20240331T100000', '2024-03-31T08:00:00.000Z'],
    ['the day before clocks go back', '20241026T100000', '2024-10-26T08:00:00.000Z'],
    ['the day clocks go back, after the change', '20241027T100000', '2024-10-27T09:00:00.000Z'],
  ])('converts central European time in %s', (_label, local, expected) => {
    expect(to_utc(WEST_EUROPE_ZONE, local)).toBe(expected);
  });

  it.each([
    ['winter', '20240115T100000', '2024-01-15T18:00:00.000Z'],
    ['summer', '20240715T100000', '2024-07-15T17:00:00.000Z'],
    // Daylight time has started in the US and not yet in Europe.
    ['mid March', '20240315T100000', '2024-03-15T17:00:00.000Z'],
  ])('converts US Pacific time in %s', (_label, local, expected) => {
    expect(to_utc(PACIFIC_ZONE, local)).toBe(expected);
  });

  it.each([
    ['January, in daylight time', '20240115T100000', '2024-01-14T23:00:00.000Z'],
    ['July, in standard time', '20240715T100000', '2024-07-15T00:00:00.000Z'],
  ])('converts a southern zone in %s', (_label, local, expected) => {
    expect(to_utc(SYDNEY_ZONE, local)).toBe(expected);
  });

  // When clocks go back, an hour of local time occurs twice. RFC 5545 section 3.3.5 and Exchange
  // both take the first occurrence, which is still in daylight time.
  it.each([
    [
      'central Europe, inside the repeated hour',
      WEST_EUROPE_ZONE,
      '20241027T023000',
      '2024-10-27T00:30:00.000Z',
    ],
    [
      'central Europe, later in the repeated hour',
      WEST_EUROPE_ZONE,
      '20241027T024500',
      '2024-10-27T00:45:00.000Z',
    ],
    [
      'central Europe, as the repeated hour begins',
      WEST_EUROPE_ZONE,
      '20241027T020000',
      '2024-10-27T00:00:00.000Z',
    ],
    [
      'central Europe, as the repeated hour ends',
      WEST_EUROPE_ZONE,
      '20241027T030000',
      '2024-10-27T02:00:00.000Z',
    ],
    [
      'the US west coast, inside the repeated hour',
      PACIFIC_ZONE,
      '20241103T013000',
      '2024-11-03T08:30:00.000Z',
    ],
    [
      'the US west coast, later in the repeated hour',
      PACIFIC_ZONE,
      '20241103T014500',
      '2024-11-03T08:45:00.000Z',
    ],
  ])('takes the first occurrence of a repeated time in %s', (_label, zone, local, expected) => {
    expect(to_utc(zone, local)).toBe(expected);
  });

  // When clocks go forward, an hour of local time does not occur. It is read with the offset in
  // effect before the gap, so it lands after the change by as much as it overshot it.
  it.each([
    [
      'central Europe, inside the skipped hour',
      WEST_EUROPE_ZONE,
      '20240331T023000',
      '2024-03-31T01:30:00.000Z',
    ],
    [
      'central Europe, an hour later',
      WEST_EUROPE_ZONE,
      '20240331T033000',
      '2024-03-31T01:30:00.000Z',
    ],
    [
      'the US west coast, inside the skipped hour',
      PACIFIC_ZONE,
      '20240310T023000',
      '2024-03-10T10:30:00.000Z',
    ],
    [
      'the US west coast, an hour later',
      PACIFIC_ZONE,
      '20240310T033000',
      '2024-03-10T10:30:00.000Z',
    ],
  ])(
    'reads a skipped time with the offset before the gap in %s',
    (_label, zone, local, expected) => {
      expect(to_utc(zone, local)).toBe(expected);
    },
  );

  it('converts a zone with no daylight time and a half-hour offset', () => {
    expect(to_utc(INDIA_ZONE, '20240715T100000')).toBe('2024-07-15T04:30:00.000Z');
  });

  it('reads the rule form Google Calendar writes, without INTERVAL', () => {
    expect(to_utc(BERLIN_ZONE, '20240715T100000')).toBe('2024-07-15T08:00:00.000Z');
    expect(to_utc(BERLIN_ZONE, '20240115T100000')).toBe('2024-01-15T09:00:00.000Z');
  });

  it('uses a rule from its first onset on, and the earlier observance before that', () => {
    const zone = zone_lines(
      'Rule From 2020',
      { dtstart: '16010101T000000', from: '+0100', to: '+0100' },
      {
        dtstart: '20200329T020000',
        from: '+0100',
        to: '+0200',
        rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      },
    );

    expect(to_utc(zone, '20190715T100000')).toBe('2019-07-15T09:00:00.000Z');
    expect(to_utc(zone, '20210715T100000')).toBe('2021-07-15T08:00:00.000Z');
  });

  // A wrong instant is worse than none, so a block the code does not model yields nothing.
  it.each([
    ['UNTIL', 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20301027T010000Z'],
    ['COUNT', 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;COUNT=5'],
    ['a two-year interval', 'FREQ=YEARLY;INTERVAL=2;BYMONTH=10;BYDAY=-1SU'],
    ['a day of the month', 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=27'],
    ['a weekday with no ordinal', 'FREQ=YEARLY;BYMONTH=10;BYDAY=SU'],
    ['a monthly frequency', 'FREQ=MONTHLY;BYMONTH=10;BYDAY=-1SU'],
    ['no month', 'FREQ=YEARLY;BYDAY=-1SU'],
  ])('refuses a rule with %s', (_label, rrule) => {
    const zone = zone_lines(
      'Unmodelled',
      { dtstart: '16010101T030000', from: '+0200', to: '+0100', rrule },
      {
        dtstart: '16010101T020000',
        from: '+0100',
        to: '+0200',
        rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      },
    );

    expect(to_utc(zone, '20240715T100000')).toBeUndefined();
  });

  it('refuses an observance that lists its onsets with RDATE', () => {
    const zone = zone_lines('Rdate Zone', {
      dtstart: '20240101T000000',
      from: '+0100',
      to: '+0100',
      extra: ['RDATE:20240101T000000'],
    });

    expect(to_utc(zone, '20240715T100000')).toBeUndefined();
  });

  it.each([
    ['an offset with seconds', '+010030'],
    ['an offset that is not one', 'CET'],
    ['an offset of sixty minutes', '+0560'],
    ['an offset of twenty-four hours', '+2400'],
  ])('refuses %s', (_label, offset) => {
    const zone = zone_lines('Odd Offset', { dtstart: '16010101T000000', from: offset, to: offset });

    expect(to_utc(zone, '20240715T100000')).toBeUndefined();
  });

  it('yields nothing for a block with no observance, or a time before its first one', () => {
    const empty = ['BEGIN:VTIMEZONE', 'TZID:Empty', 'END:VTIMEZONE'];
    const from_2020 = zone_lines('From 2020', {
      dtstart: '20200101T000000',
      from: '+0100',
      to: '+0100',
    });

    expect(to_utc(empty, '20240715T100000')).toBeUndefined();
    expect(to_utc(from_2020, '20190715T100000')).toBeUndefined();
  });
});

describe('parse_local_date_time', () => {
  it('reads a local date-time as the instant it would be at UTC', () => {
    expect(parse_local_date_time('20250310T090000')).toBe(Date.UTC(2025, 2, 10, 9, 0, 0));
  });

  it.each(['20250310', '20250310T0900', '20250310T090000Z', 'not a time', ''])(
    'rejects %j, which is not a local date-time',
    (value) => {
      expect(parse_local_date_time(value)).toBeUndefined();
    },
  );

  // Date.UTC would roll these over to a real date, which would be a silent wrong time.
  it.each(['20250230T090000', '20251301T090000', '20250310T250000', '20250310T096100'])(
    'rejects %s, a date or time that does not exist',
    (value) => {
      expect(parse_local_date_time(value)).toBeUndefined();
    },
  );
});
