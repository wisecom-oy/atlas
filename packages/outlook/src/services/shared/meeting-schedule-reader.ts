import {
  find_component,
  find_property,
  parse_icalendar,
} from '@/services/shared/icalendar-document';
import type { IcalendarComponent, IcalendarProperty } from '@/services/shared/icalendar-document';
import {
  convert_zone_local_time_to_utc,
  parse_local_date_time,
} from '@/services/shared/icalendar-time-zone';
import type { MeetingCalendarPart } from '@/services/shared/meeting-calendar-parts';
import { read_meeting_identity } from '@/services/shared/meeting-identity-reader';
import type { MeetingIdentity } from '@/services/shared/meeting-identity-reader';

/** When a meeting takes place, as UTC instants in ISO 8601. */
export interface MeetingTime {
  readonly start: string;
  readonly end: string;
  /** Whether the calendar part gave whole days (`VALUE=DATE`) and not times of day. */
  readonly is_all_day: boolean;
}

/** What a meeting message says about its meeting, beyond the answer (issue #819). */
export interface MeetingSchedule {
  /** Absent when the calendar part does not pin both instants down. */
  readonly time?: MeetingTime;
  readonly location?: string;
  /** Absent when the calendar part does not name its meeting with certainty. */
  readonly identity?: MeetingIdentity;
}

/**
 * A longer `LOCATION` is left out, not cut: a cut value is a different value from the source's.
 * Graph took 40,000 characters in a probe, so the limit only keeps a hostile value out of the
 * create request.
 */
const MAX_LOCATION_LENGTH = 1024;

/** Graph moves an earlier time to this instant without saying so, which would be a wrong time. */
const EARLIEST_MAPI_TIME_MS = Date.UTC(1601, 0, 1);

/** The charsets whose bytes the iCalendar text can be read from as UTF-8 without loss. */
const UTF8_COMPATIBLE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

/**
 * Reads the meeting time, location and identity from the calendar part of a meeting message, the way
 * Exchange Online read the same parts in a live comparison (issue #819).
 *
 * The time is returned only when it is certain, because a wrong time on a restored item is worse
 * than none. `DTSTART` and `DTEND` must both be present and of the same form:
 *
 * - UTC times (`20250310T090000Z`).
 * - Local times with a `TZID` whose `VTIMEZONE` block is in the same document.
 * - All-day dates (`VALUE=DATE`). Exchange places them at midnight in the document's zone when it
 *   has exactly one `VTIMEZONE` block, and at midnight UTC otherwise.
 *
 * A floating local time, a `TZID` with no block, a `DURATION` in place of `DTEND` and a zone rule
 * this code does not model all leave the time out. Exchange resolves some of those, by looking
 * the zone name up or by assuming UTC, and Atlas does not guess along.
 */
export function read_meeting_schedule(part: MeetingCalendarPart): MeetingSchedule | undefined {
  const calendar = find_component(parse_icalendar(part.icalendar), 'VCALENDAR');
  const event = calendar && find_component(calendar, 'VEVENT');
  if (calendar === undefined || event === undefined) return undefined;

  // Location and UID are text, and the bytes were decoded as UTF-8 whatever the part declared.
  const is_text_readable = is_readable_as_utf8(part.charset);
  const time = read_meeting_time(calendar, event);
  const location = is_text_readable ? read_location(event) : undefined;
  const identity = is_text_readable ? read_meeting_identity(event) : undefined;
  if (time === undefined && location === undefined && identity === undefined) return undefined;
  return {
    ...(time ? { time } : {}),
    ...(location ? { location } : {}),
    ...(identity ? { identity } : {}),
  };
}

/** Whether text decoded as UTF-8 is what the part's declared charset meant. */
function is_readable_as_utf8(charset: string | undefined): boolean {
  return charset === undefined || UTF8_COMPATIBLE_CHARSETS.has(charset);
}

/** Reads start and end, or nothing unless both resolve to a sane span of the same form. */
function read_meeting_time(
  calendar: IcalendarComponent,
  event: IcalendarComponent,
): MeetingTime | undefined {
  const start = find_property(event, 'DTSTART');
  const end = find_property(event, 'DTEND');
  if (start === undefined || end === undefined) return undefined;

  const is_all_day = is_date_value(start);
  if (is_date_value(end) !== is_all_day) return undefined;
  const resolve = is_all_day ? resolve_all_day_instant : resolve_timed_instant;
  const start_ms = resolve(calendar, start);
  const end_ms = resolve(calendar, end);

  if (start_ms === undefined || end_ms === undefined) return undefined;
  if (end_ms < start_ms || start_ms < EARLIEST_MAPI_TIME_MS) return undefined;
  return {
    start: new Date(start_ms).toISOString(),
    end: new Date(end_ms).toISOString(),
    is_all_day,
  };
}

/** Whether a `DTSTART` or `DTEND` holds a whole day (`VALUE=DATE:20250310`). */
function is_date_value(property: IcalendarProperty): boolean {
  return (
    property.parameters.get('VALUE')?.toUpperCase() === 'DATE' ||
    /^\d{8}$/.test(property.value.trim())
  );
}

/** Resolves a date-time property to a UTC instant in milliseconds. */
function resolve_timed_instant(
  calendar: IcalendarComponent,
  property: IcalendarProperty,
): number | undefined {
  const value = property.value.trim();
  if (value.endsWith('Z')) return parse_local_date_time(value.slice(0, -1));

  const zone_id = property.parameters.get('TZID');
  if (zone_id === undefined) return undefined;
  const zone = list_time_zones(calendar).find(
    (candidate) => find_property(candidate, 'TZID')?.value.trim() === zone_id,
  );
  const local_ms = parse_local_date_time(value);
  if (zone === undefined || local_ms === undefined) return undefined;
  return convert_zone_local_time_to_utc(zone, local_ms);
}

/**
 * Resolves an all-day date to the instant its day starts. A date names no zone of its own, so
 * the document's only `VTIMEZONE` block decides. With no block, or with several, it is midnight
 * UTC.
 */
function resolve_all_day_instant(
  calendar: IcalendarComponent,
  property: IcalendarProperty,
): number | undefined {
  const midnight_ms = parse_local_date_time(`${property.value.trim()}T000000`);
  if (midnight_ms === undefined) return undefined;
  const [zone, ...other_zones] = list_time_zones(calendar);
  const has_one_zone = zone !== undefined && other_zones.length === 0;
  return has_one_zone ? convert_zone_local_time_to_utc(zone, midnight_ms) : midnight_ms;
}

/** The `VTIMEZONE` blocks of a calendar. */
function list_time_zones(calendar: IcalendarComponent): IcalendarComponent[] {
  return calendar.components.filter((component) => component.name === 'VTIMEZONE');
}

/** Reads `LOCATION` as plain text, or nothing when it is empty or implausibly long. */
function read_location(event: IcalendarComponent): string | undefined {
  const raw = find_property(event, 'LOCATION')?.value;
  if (raw === undefined) return undefined;
  const location = unescape_icalendar_text(raw);
  const is_usable = location.trim().length > 0 && location.length <= MAX_LOCATION_LENGTH;
  return is_usable ? location : undefined;
}

/**
 * Undoes RFC 5545 TEXT escaping: `\n`, `\,`, `\;` and `\\`. A line break becomes CRLF, which is
 * what Exchange stores for it.
 */
function unescape_icalendar_text(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, escaped: string) =>
    escaped === 'n' || escaped === 'N' ? '\r\n' : escaped,
  );
}
