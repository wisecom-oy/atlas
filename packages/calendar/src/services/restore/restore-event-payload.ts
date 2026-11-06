import { is_record } from '@/services/shared/json-record';
import { source_tag_property } from '@/services/shared/source-tag';

/**
 * Fields Graph owns or regenerates on create, plus the ones restore must not send:
 * `attendees` and `organizer` would email invitations to every attendee, and the online meeting
 * fields would provision a new Teams meeting for an event that already happened.
 */
const DROPPED_FIELDS: Readonly<Record<string, true>> = {
  id: true,
  createdDateTime: true,
  lastModifiedDateTime: true,
  changeKey: true,
  iCalUId: true,
  iCalUId_v2: true,
  uid: true,
  webLink: true,
  transactionId: true,
  bodyPreview: true,
  hasAttachments: true,
  isOrganizer: true,
  isCancelled: true,
  isDraft: true,
  responseStatus: true,
  seriesMasterId: true,
  occurrenceId: true,
  type: true,
  originalStart: true,
  originalStartTimeZone: true,
  originalEndTimeZone: true,
  organizer: true,
  attendees: true,
  exceptionOccurrences: true,
  cancelledOccurrences: true,
  onlineMeeting: true,
  onlineMeetingUrl: true,
  isOnlineMeeting: true,
  onlineMeetingProvider: true,
};

/** Fields an exception occurrence may carry over its series; recurrence belongs to the master. */
const EXCEPTION_FIELDS: Readonly<Record<string, true>> = {
  subject: true,
  body: true,
  start: true,
  end: true,
  isAllDay: true,
  location: true,
  locations: true,
  showAs: true,
  importance: true,
  sensitivity: true,
  categories: true,
  reminderMinutesBeforeStart: true,
  isReminderOn: true,
};

function escape_html(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `Name <address>` for a Graph recipient, or undefined when it has neither. */
function describe_recipient(recipient: unknown): string | undefined {
  if (!is_record(recipient) || !is_record(recipient['emailAddress'])) return undefined;
  const { name, address } = recipient['emailAddress'];
  const label = typeof name === 'string' ? name.trim() : '';
  const mail = typeof address === 'string' ? address.trim() : '';
  if (label === '' && mail === '') return undefined;
  return mail === '' || label === mail ? label || mail : `${label} <${mail}>`.trim();
}

function describe_attendee(attendee: unknown): string | undefined {
  const who = describe_recipient(attendee);
  if (who === undefined || !is_record(attendee)) return who;
  const role = typeof attendee['type'] === 'string' ? attendee['type'] : undefined;
  const status = is_record(attendee['status']) ? attendee['status']['response'] : undefined;
  const details = [role, typeof status === 'string' && status !== 'none' ? status : undefined];
  const known = details.filter((d): d is string => d !== undefined);
  return known.length === 0 ? who : `${who} (${known.join(', ')})`;
}

/**
 * Text lines naming the original organizer and attendees, or none for an event the mailbox
 * organized alone. This is how attendees survive restore without being re-invited.
 */
export function attendee_summary_lines(event: Readonly<Record<string, unknown>>): string[] {
  const attendees = Array.isArray(event['attendees'])
    ? event['attendees'].map(describe_attendee).filter((a): a is string => a !== undefined)
    : [];
  const organizer =
    event['isOrganizer'] === false ? describe_recipient(event['organizer']) : undefined;
  if (attendees.length === 0 && organizer === undefined) return [];
  return [
    'Restored by Atlas. Attendees were not re-invited.',
    ...(organizer === undefined ? [] : [`Organizer: ${organizer}`]),
    ...(attendees.length === 0 ? [] : [`Attendees: ${attendees.join('; ')}`]),
  ];
}

/** The event body with the attendee summary placed before the original content. */
function body_with_summary(body: unknown, lines: readonly string[]): unknown {
  if (lines.length === 0) return body;
  const original = is_record(body) ? body : {};
  const content = typeof original['content'] === 'string' ? original['content'] : '';
  if (original['contentType'] !== 'html') {
    const text = content === '' ? lines.join('\n') : `${lines.join('\n')}\n\n${content}`;
    return { contentType: 'text', content: text };
  }
  const block = `<p>${lines.map(escape_html).join('<br>')}</p><hr>`;
  const body_tag = /<body[^>]*>/i.exec(content);
  const merged =
    body_tag === null
      ? `${block}${content}`
      : `${content.slice(0, body_tag.index + body_tag[0].length)}${block}${content.slice(body_tag.index + body_tag[0].length)}`;
  return { contentType: 'html', content: merged };
}

function writable_fields(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).filter(
      ([field]) =>
        !field.startsWith('@') && !field.includes('@odata') && DROPPED_FIELDS[field] !== true,
    ),
  );
}

/** The POST body that recreates a stored event, tagged with the id it was restored from. */
export function build_create_payload(
  event: Readonly<Record<string, unknown>>,
  source_event_id: string,
): Record<string, unknown> {
  return {
    ...writable_fields(event),
    body: body_with_summary(event['body'], attendee_summary_lines(event)),
    singleValueExtendedProperties: [source_tag_property(source_event_id)],
  };
}

/** The PATCH body that turns a restored occurrence into the stored exception. */
export function build_exception_patch(
  exception: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.entries(exception).filter(([field]) => EXCEPTION_FIELDS[field] === true),
  );
  return {
    ...fields,
    body: body_with_summary(exception['body'], attendee_summary_lines(exception)),
  };
}
