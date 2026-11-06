import { is_record } from '@/services/shared/json-record';

/**
 * Single-value extended property that tags an event Atlas restored with the id of the event it
 * was restored from, so a repeated restore recognises its own earlier output.
 */
export const SOURCE_EVENT_PROPERTY_ID =
  'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasSourceEventId';

/** The source event id an event was restored from, or undefined when it carries no Atlas tag. */
export function source_tag_of(event: Readonly<Record<string, unknown>>): string | undefined {
  const props = event['singleValueExtendedProperties'];
  if (!Array.isArray(props)) return undefined;
  for (const prop of props) {
    if (is_record(prop) && prop['id'] === SOURCE_EVENT_PROPERTY_ID) {
      return typeof prop['value'] === 'string' ? prop['value'] : undefined;
    }
  }
  return undefined;
}

/** The extended property that tags a created event with its source event id. */
export function source_tag_property(source_event_id: string): Record<string, string> {
  return { id: SOURCE_EVENT_PROPERTY_ID, value: source_event_id };
}
