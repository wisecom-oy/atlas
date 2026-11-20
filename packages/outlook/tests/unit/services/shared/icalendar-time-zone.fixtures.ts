/** `VTIMEZONE` blocks as mail systems write them, and calendar documents built around them. */

interface ObservanceLines {
  readonly dtstart: string;
  readonly from: string;
  readonly to: string;
  readonly rrule?: string;
  /** Lines added to the block as they are, such as an `RDATE`. */
  readonly extra?: readonly string[];
}

/** Renders one `STANDARD` or `DAYLIGHT` block. */
function observance_lines(kind: 'STANDARD' | 'DAYLIGHT', observance: ObservanceLines): string[] {
  return [
    `BEGIN:${kind}`,
    `DTSTART:${observance.dtstart}`,
    `TZOFFSETFROM:${observance.from}`,
    `TZOFFSETTO:${observance.to}`,
    ...(observance.rrule ? [`RRULE:${observance.rrule}`] : []),
    ...(observance.extra ?? []),
    `END:${kind}`,
  ];
}

/** Renders a `VTIMEZONE` block with a standard observance and, optionally, a daylight one. */
export function zone_lines(
  id: string,
  standard: ObservanceLines,
  daylight?: ObservanceLines,
): string[] {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${id}`,
    ...observance_lines('STANDARD', standard),
    ...(daylight ? observance_lines('DAYLIGHT', daylight) : []),
    'END:VTIMEZONE',
  ];
}

/** Exchange's block for central Europe: last Sunday of March and of October. */
export const WEST_EUROPE_ZONE = zone_lines(
  'W. Europe Standard Time',
  {
    dtstart: '16010101T030000',
    from: '+0200',
    to: '+0100',
    rrule: 'FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  },
  {
    dtstart: '16010101T020000',
    from: '+0100',
    to: '+0200',
    rrule: 'FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  },
);

/** Exchange's block for the US west coast: second Sunday of March, first Sunday of November. */
export const PACIFIC_ZONE = zone_lines(
  'Pacific Standard Time',
  {
    dtstart: '16010101T020000',
    from: '-0700',
    to: '-0800',
    rrule: 'FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
  },
  {
    dtstart: '16010101T020000',
    from: '-0800',
    to: '-0700',
    rrule: 'FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
  },
);

/** A southern zone: daylight time runs from October to April, across the turn of the year. */
export const SYDNEY_ZONE = zone_lines(
  'AUS Eastern Standard Time',
  {
    dtstart: '16010101T030000',
    from: '+1100',
    to: '+1000',
    rrule: 'FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=4',
  },
  {
    dtstart: '16010101T020000',
    from: '+1000',
    to: '+1100',
    rrule: 'FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=10',
  },
);

/** A zone with no daylight time and a half-hour offset. */
export const INDIA_ZONE = zone_lines('India Standard Time', {
  dtstart: '16010101T000000',
  from: '+0530',
  to: '+0530',
});

/** Google Calendar's form: an IANA zone id and rules without `INTERVAL`. */
export const BERLIN_ZONE = zone_lines(
  'Europe/Berlin',
  {
    dtstart: '19701025T030000',
    from: '+0200',
    to: '+0100',
    rrule: 'FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  },
  {
    dtstart: '19700329T020000',
    from: '+0100',
    to: '+0200',
    rrule: 'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  },
);

/** What a schedule test varies: the zone blocks and the lines of the event. */
export interface ScheduleIcalendarOptions {
  readonly zones?: readonly (readonly string[])[];
  /** `DTSTART`, `DTEND`, `LOCATION` and any other event line, each as a whole content line. */
  readonly event_lines: readonly string[];
}

/** Builds a meeting reply whose time zone blocks and event lines the test chooses. */
export function build_schedule_icalendar(options: ScheduleIcalendarOptions): string {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Example Corp//Calendar//EN',
    'VERSION:2.0',
    'METHOD:REPLY',
    ...(options.zones ?? []).flat(),
    'BEGIN:VEVENT',
    'UID:meeting-4c1f@partner.example',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:jane.roe@partner.example',
    'SUMMARY:Example subject',
    ...options.event_lines,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
