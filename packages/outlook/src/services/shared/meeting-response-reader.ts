import {
  find_component,
  find_property,
  parse_icalendar,
} from '@/services/shared/icalendar-document';
import type { MeetingCalendarPart } from '@/services/shared/meeting-calendar-parts';

/** How the attendee answered, as Exchange classes a meeting response. */
export type MeetingResponse = 'accepted' | 'declined' | 'tentative';

/**
 * Reads the answer a meeting response carries, the way Exchange Online classes it (issue #817).
 *
 * A `REPLY` takes the participation status of its first attendee: `ACCEPTED` and `DECLINED` map
 * to themselves, and every other status, or none, is tentative. A `COUNTER` is tentative. Requests
 * and cancellations are not responses and return nothing, and so does a reply with no attendee.
 */
export function read_meeting_response(part: MeetingCalendarPart): MeetingResponse | undefined {
  if (part.method === 'COUNTER') return 'tentative';
  if (part.method !== 'REPLY') return undefined;

  const calendar = find_component(parse_icalendar(part.icalendar), 'VCALENDAR');
  const event = calendar && find_component(calendar, 'VEVENT');
  const attendee = event && find_property(event, 'ATTENDEE');
  if (attendee === undefined) return undefined;
  const status = attendee.parameters.get('PARTSTAT')?.toUpperCase();
  if (status === 'ACCEPTED') return 'accepted';
  if (status === 'DECLINED') return 'declined';
  return 'tentative';
}
