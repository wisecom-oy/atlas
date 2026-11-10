import { is_record } from '@/services/shared/json-record';

const PROPERTY_SET = 'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name';

/**
 * Single-value extended property that tags an event Atlas restored completely with the id of the
 * event it was restored from, so a repeated restore recognises its own earlier output.
 */
export const SOURCE_EVENT_PROPERTY_ID = `${PROPERTY_SET} AtlasSourceEventId`;

/**
 * Tags a restored event whose attachments or recurrence changes are still being written. It stays
 * without the complete tag when one of those steps fails, so a repeated restore replaces it.
 */
export const PENDING_SOURCE_EVENT_PROPERTY_ID = `${PROPERTY_SET} AtlasPendingSourceEventId`;

/**
 * The iCalUId of the event a restored event was created from. Graph gives the created event a new
 * iCalUId, so this is how a repeated restore matches another entry that shares the original one.
 */
export const SOURCE_ICAL_UID_PROPERTY_ID = `${PROPERTY_SET} AtlasSourceICalUId`;

/** Every restore tag, as `list_calendar_events` expands them. */
export const RESTORE_TAG_PROPERTY_IDS: readonly string[] = [
  SOURCE_EVENT_PROPERTY_ID,
  PENDING_SOURCE_EVENT_PROPERTY_ID,
  SOURCE_ICAL_UID_PROPERTY_ID,
];

/** Whether the created event is complete, or still waits for attachments or series changes. */
export type RestoreState = 'complete' | 'pending';

/** The string value of one single-value extended property, or undefined when the event lacks it. */
function extended_property_value(
  event: Readonly<Record<string, unknown>>,
  property_id: string,
): string | undefined {
  const props = event['singleValueExtendedProperties'];
  if (!Array.isArray(props)) return undefined;
  for (const prop of props) {
    if (is_record(prop) && prop['id'] === property_id) {
      return typeof prop['value'] === 'string' ? prop['value'] : undefined;
    }
  }
  return undefined;
}

/** The source event id an event was completely restored from, or undefined when it is not. */
export function source_tag_of(event: Readonly<Record<string, unknown>>): string | undefined {
  return extended_property_value(event, SOURCE_EVENT_PROPERTY_ID);
}

/** The source event id of an event a restore created but never finished, or undefined. */
export function pending_tag_of(event: Readonly<Record<string, unknown>>): string | undefined {
  if (source_tag_of(event) !== undefined) return undefined;
  return extended_property_value(event, PENDING_SOURCE_EVENT_PROPERTY_ID);
}

/** The original iCalUId of a completely restored event, or undefined. */
export function source_ical_uid_of(event: Readonly<Record<string, unknown>>): string | undefined {
  if (source_tag_of(event) === undefined) return undefined;
  return extended_property_value(event, SOURCE_ICAL_UID_PROPERTY_ID);
}

/** The extended property that tags a completely restored event with its source event id. */
export function source_tag_property(source_event_id: string): Record<string, string> {
  return { id: SOURCE_EVENT_PROPERTY_ID, value: source_event_id };
}

/** The tags a restored event is created with: its state, and its original iCalUId when known. */
export function restore_tags_for(
  source_event_id: string,
  ical_uid: string | undefined,
  state: RestoreState,
): Record<string, string>[] {
  const state_tag =
    state === 'complete'
      ? source_tag_property(source_event_id)
      : { id: PENDING_SOURCE_EVENT_PROPERTY_ID, value: source_event_id };
  return ical_uid === undefined
    ? [state_tag]
    : [state_tag, { id: SOURCE_ICAL_UID_PROPERTY_ID, value: ical_uid }];
}
