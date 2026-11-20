import { find_property } from '@/services/shared/icalendar-document';
import type { IcalendarComponent } from '@/services/shared/icalendar-document';

const MS_PER_MINUTE = 60_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * A yearly transition on the nth weekday of a month, such as the last Sunday of October. This is
 * the only recurrence form mail systems were seen to write into a `VTIMEZONE`.
 */
interface YearlyRule {
  /** 1 to 12. */
  readonly month: number;
  /** 0 for Sunday to 6 for Saturday. */
  readonly weekday: number;
  /** 1 to 5 from the start of the month, -1 to -5 from its end. */
  readonly ordinal: number;
}

/** One `STANDARD` or `DAYLIGHT` block: when it starts applying and the offset it switches to. */
interface Observance {
  /** The first onset, as wall-clock time under `offset_from_minutes`. */
  readonly first_onset_local_ms: number;
  readonly offset_from_minutes: number;
  readonly offset_to_minutes: number;
  /** Absent when the observance starts once and then holds. */
  readonly rule?: YearlyRule;
}

/**
 * Parses an iCalendar local date-time (`20250310T090000`) into the milliseconds it would be if
 * the wall clock were UTC. The zone is applied separately.
 */
export function parse_local_date_time(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  // The pattern has exactly six digit groups, so the tuple is what the match holds.
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const local_ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls an impossible date over to a real one, which would be a silent wrong time.
  const check = new Date(local_ms);
  const is_real_date =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second;
  return is_real_date ? local_ms : undefined;
}

/**
 * Converts a wall-clock time in the zone a `VTIMEZONE` block describes to a UTC instant in
 * milliseconds.
 *
 * The zone's own rules are used, not a time zone database: the sender wrote them for exactly
 * this event, and a Windows zone name such as `W. Europe Standard Time` is not one a database
 * lookup would resolve. Returns nothing when the block has a rule this module does not model,
 * or names no observance for the time. A wrong instant is worse than none, so the caller then
 * leaves the time out.
 */
export function convert_zone_local_time_to_utc(
  zone: IcalendarComponent,
  local_ms: number,
): number | undefined {
  const observances: Observance[] = [];
  for (const component of zone.components) {
    if (component.name !== 'STANDARD' && component.name !== 'DAYLIGHT') continue;
    const observance = parse_observance(component);
    if (observance === undefined) return undefined;
    observances.push(observance);
  }

  return resolve_local_time(observances, local_ms);
}

/**
 * Resolves a wall-clock time to an instant under a zone's observances.
 *
 * Each offset the zone uses gives one reading of the time. A reading holds when that offset is
 * the one in effect at the instant it yields. Almost always exactly one holds. The two hours a
 * year where that fails are settled the way RFC 5545 section 3.3.5 says, which is also what
 * Exchange Online did with them in a live comparison:
 *
 * - When clocks go back, the time occurs twice and two readings hold. The first occurrence wins.
 * - When clocks go forward, the time does not occur and no reading holds. It is read with the
 *   offset in effect before the gap.
 */
function resolve_local_time(
  observances: readonly Observance[],
  local_ms: number,
): number | undefined {
  const offsets = [...new Set(observances.map((observance) => observance.offset_to_minutes))];
  const readings = offsets
    .map((offset_minutes) => {
      const instant_ms = local_ms - offset_minutes * MS_PER_MINUTE;
      return {
        instant_ms,
        holds: find_offset_at_instant(observances, instant_ms) === offset_minutes,
      };
    })
    .sort((a, b) => a.instant_ms - b.instant_ms);

  const first_occurrence = readings.find((reading) => reading.holds);
  if (first_occurrence !== undefined) return first_occurrence.instant_ms;

  const earliest = readings[0];
  const offset_before_gap = earliest && find_offset_at_instant(observances, earliest.instant_ms);
  return offset_before_gap === undefined ? undefined : local_ms - offset_before_gap * MS_PER_MINUTE;
}

/** The offset in effect at a UTC instant: that of the observance with the latest onset before it. */
function find_offset_at_instant(
  observances: readonly Observance[],
  instant_ms: number,
): number | undefined {
  const year = new Date(instant_ms).getUTCFullYear();
  let latest_onset_utc_ms = Number.NEGATIVE_INFINITY;
  let offset_minutes: number | undefined;

  for (const observance of observances) {
    for (const onset_local_ms of list_onsets_around_year(observance, year)) {
      const onset_utc_ms = onset_local_ms - observance.offset_from_minutes * MS_PER_MINUTE;
      if (onset_utc_ms > instant_ms || onset_utc_ms <= latest_onset_utc_ms) continue;
      latest_onset_utc_ms = onset_utc_ms;
      offset_minutes = observance.offset_to_minutes;
    }
  }
  return offset_minutes;
}

/**
 * The onsets of an observance that can govern an instant in this year: those of the year before,
 * the year itself and the year after, since an onset is dated in local time.
 */
function list_onsets_around_year(observance: Observance, year: number): number[] {
  const { rule, first_onset_local_ms } = observance;
  if (rule === undefined) return [first_onset_local_ms];

  const time_of_day_ms = first_onset_local_ms - start_of_utc_day(first_onset_local_ms);
  return [year - 1, year, year + 1]
    .map((onset_year) => find_nth_weekday_of_month(onset_year, rule))
    .filter((day_ms): day_ms is number => day_ms !== undefined)
    .map((day_ms) => day_ms + time_of_day_ms)
    .filter((onset_ms) => onset_ms >= first_onset_local_ms);
}

/** Midnight of the UTC day a timestamp falls on. */
function start_of_utc_day(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Midnight of the nth given weekday of a month, or nothing when the month has no such day. */
function find_nth_weekday_of_month(year: number, rule: YearlyRule): number | undefined {
  const month_index = rule.month - 1;
  const days_in_month = new Date(Date.UTC(year, month_index + 1, 0)).getUTCDate();
  const anchor_day = rule.ordinal > 0 ? 1 : days_in_month;
  const anchor_weekday = new Date(Date.UTC(year, month_index, anchor_day)).getUTCDay();

  const day =
    rule.ordinal > 0
      ? 1 + ((rule.weekday - anchor_weekday + 7) % 7) + 7 * (rule.ordinal - 1)
      : days_in_month - ((anchor_weekday - rule.weekday + 7) % 7) + 7 * (rule.ordinal + 1);
  return day >= 1 && day <= days_in_month ? Date.UTC(year, month_index, day) : undefined;
}

/** Reads one `STANDARD` or `DAYLIGHT` block, or nothing when it cannot be modelled exactly. */
function parse_observance(component: IcalendarComponent): Observance | undefined {
  const first_onset_local_ms = parse_local_date_time(
    find_property(component, 'DTSTART')?.value ?? '',
  );
  const offset_from_minutes = parse_utc_offset(find_property(component, 'TZOFFSETFROM')?.value);
  const offset_to_minutes = parse_utc_offset(find_property(component, 'TZOFFSETTO')?.value);
  if (
    first_onset_local_ms === undefined ||
    offset_from_minutes === undefined ||
    offset_to_minutes === undefined
  ) {
    return undefined;
  }
  // RDATE lists onsets one by one. It is not modelled, so a block that uses it is refused.
  if (find_property(component, 'RDATE')) return undefined;

  const rrule = find_property(component, 'RRULE');
  if (rrule === undefined) return { first_onset_local_ms, offset_from_minutes, offset_to_minutes };
  const rule = parse_yearly_rule(rrule.value);
  if (rule === undefined) return undefined;
  return { first_onset_local_ms, offset_from_minutes, offset_to_minutes, rule };
}

/** Parses `+0200`, `-0500` or `+053000` into minutes east of UTC. Seconds are not modelled. */
function parse_utc_offset(value: string | undefined): number | undefined {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value?.trim() ?? '');
  if (!match || (match[4] !== undefined && match[4] !== '00')) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return undefined;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Parses `FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU`, with an optional `INTERVAL=1`. Any other part,
 * such as `UNTIL` or `COUNT`, makes the rule one this module does not model.
 */
function parse_yearly_rule(value: string): YearlyRule | undefined {
  const parts = new Map<string, string>();
  for (const part of value.trim().split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) return undefined;
    parts.set(part.slice(0, separator).toUpperCase(), part.slice(separator + 1).toUpperCase());
  }

  const by_day = /^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.exec(parts.get('BYDAY') ?? '');
  const month = Number(parts.get('BYMONTH'));
  const is_modelled =
    parts.get('FREQ') === 'YEARLY' &&
    (parts.get('INTERVAL') ?? '1') === '1' &&
    [...parts.keys()].every((key) => ['FREQ', 'INTERVAL', 'BYMONTH', 'BYDAY'].includes(key)) &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12;
  if (!is_modelled || !by_day) return undefined;
  return { month, weekday: WEEKDAYS.indexOf(by_day[2]!), ordinal: Number(by_day[1]) };
}
