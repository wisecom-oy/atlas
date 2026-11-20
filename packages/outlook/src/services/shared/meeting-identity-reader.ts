import { find_property } from '@/services/shared/icalendar-document';
import type { IcalendarComponent } from '@/services/shared/icalendar-document';

/** A calendar date with no time and no zone. */
export interface CalendarDate {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
}

/** Which meeting a meeting message is about (issue #819). */
export interface MeetingIdentity {
  /** The iCalendar `UID` of the meeting, as the calendar part wrote it. */
  readonly uid: string;
  /** For a message about one occurrence of a series: the date that occurrence was first set for. */
  readonly occurrence_date?: CalendarDate;
}

/** A longer `UID` is no meeting's identifier, and the limit keeps one out of the create request. */
const MAX_UID_LENGTH = 1024;

/**
 * Reads the identity of the meeting from its `VEVENT`: the `UID`, and the original date of the
 * occurrence when the message is about a single one.
 *
 * Returns nothing when the identity is not certain: no `UID`, one with a TEXT escape in it, or a
 * `RECURRENCE-ID` in a form other than a local time with a `TZID`. Exchange's own messages write
 * that form, and it is the only one whose date was compared with the identifier Exchange stored.
 * A response restored without an identity is not linked to its meeting, which is the safe side.
 */
export function read_meeting_identity(event: IcalendarComponent): MeetingIdentity | undefined {
  const uid = find_property(event, 'UID')?.value.trim();
  if (!uid || uid.length > MAX_UID_LENGTH || uid.includes('\\')) return undefined;

  const recurrence_id = find_property(event, 'RECURRENCE-ID');
  if (recurrence_id === undefined) return { uid };

  const local = /^(\d{4})(\d{2})(\d{2})T\d{6}$/.exec(recurrence_id.value.trim());
  if (!local || !recurrence_id.parameters.has('TZID')) return undefined;
  const occurrence_date = {
    year: Number(local[1]),
    month: Number(local[2]),
    day: Number(local[3]),
  };
  return { uid, occurrence_date };
}
