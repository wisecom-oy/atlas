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

  const attendee = find_first_attendee_line(part.icalendar.toString('utf-8'));
  if (attendee === undefined) return undefined;
  const status = read_property_parameter(attendee, 'PARTSTAT')?.toUpperCase();
  if (status === 'ACCEPTED') return 'accepted';
  if (status === 'DECLINED') return 'declined';
  return 'tentative';
}

/** Returns the first ATTENDEE content line, with RFC 5545 line folding undone. */
function find_first_attendee_line(icalendar: string): string | undefined {
  const unfolded = icalendar.replace(/\r?\n[ \t]/g, '');
  return unfolded.split(/\r?\n/).find((line) => /^ATTENDEE[;:]/i.test(line));
}

/**
 * Reads one parameter of an iCalendar content line, such as `PARTSTAT` in
 * `ATTENDEE;CN="Roe; Jane";PARTSTAT=ACCEPTED:mailto:...`. Quoted parameter values may contain
 * `;` and `:`, so the line is scanned rather than split.
 */
function read_property_parameter(line: string, name: string): string | undefined {
  const wanted = `${name.toUpperCase()}=`;
  for (const parameter of split_property_parameters(line)) {
    if (parameter.toUpperCase().startsWith(wanted)) {
      return parameter.slice(wanted.length).replace(/^"|"$/g, '').trim();
    }
  }
  return undefined;
}

/** Splits the parameters between a property name and its value, honouring quoted values. */
function split_property_parameters(line: string): string[] {
  const parameters: string[] = [];
  let current: string | undefined;
  let in_quotes = false;

  for (const char of line) {
    if (char === '"') in_quotes = !in_quotes;
    const is_separator = !in_quotes && (char === ';' || char === ':');
    if (!is_separator) {
      if (current !== undefined) current += char;
      continue;
    }
    if (current !== undefined) parameters.push(current);
    if (char === ':') return parameters;
    current = '';
  }
  return parameters;
}
