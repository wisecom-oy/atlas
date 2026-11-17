import { createHash } from 'node:crypto';

import type {
  CalendarAttachmentRecord,
  CalendarEventEntry,
  CalendarRecord,
} from '@/domain/calendar/manifest';
import type { GraphEventPayload } from '@/ports/calendar/connector.port';
import type { MemoryCalendarManifests } from '@/testing/stub-calendar-ports';

export const TENANT = 'tenant-1';
export const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
export const SNAPSHOT = 'cal-snap-1-abc';
/** Extended property that stamps each completely restored event with its source event id. */
export const SOURCE_TAG_ID =
  'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasSourceEventId';
/** Extended property that stamps a restored event until its attachments and series changes land. */
export const PENDING_TAG_ID =
  'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasPendingSourceEventId';
/** Extended property that records the original iCalUId on each restored event. */
export const SOURCE_ICAL_UID_TAG_ID =
  'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name AtlasSourceICalUId';

/** Source calendars of a snapshot: a default calendar and a writable `Work` calendar. */
export const SOURCE_CALENDARS: CalendarRecord[] = [
  { calendar_id: 'src-default', display_name: 'Calendar', is_default: true },
  { calendar_id: 'src-work', display_name: 'Work', is_default: false },
];

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stores an event payload the way the backup does and returns its manifest entry. */
export function stored_event(
  objects: Record<string, Buffer>,
  calendar_id: string,
  payload: GraphEventPayload,
  attachments?: CalendarAttachmentRecord[],
): CalendarEventEntry {
  const bytes = Buffer.from(JSON.stringify(payload));
  const storage_key = `calendar/data/${MAILBOX}/${sha256(bytes)}`;
  objects[storage_key] = bytes;
  return {
    event_id: String(payload.id),
    calendar_id,
    event_type: String(payload.type),
    subject: String(payload.subject),
    storage_key,
    checksum: sha256(bytes),
    size_bytes: bytes.length,
    attachments,
  };
}

/** Stores one file attachment's bytes and returns its manifest record. */
export function stored_file(
  objects: Record<string, Buffer>,
  attachment_id: string,
  name: string,
  content: string,
): CalendarAttachmentRecord {
  const bytes = Buffer.from(content);
  const storage_key = `calendar/attachments/${MAILBOX}/${sha256(bytes)}`;
  objects[storage_key] = bytes;
  return {
    attachment_id,
    name,
    content_type: 'application/pdf',
    is_inline: false,
    storage_key,
    checksum: sha256(bytes),
    size_bytes: bytes.length,
  };
}

/** Seeds the snapshot manifest a backup run would have left behind. */
export function save_snapshot(
  manifests: MemoryCalendarManifests,
  entries: CalendarEventEntry[],
  calendars: CalendarRecord[] = SOURCE_CALENDARS,
): void {
  manifests.saved.push({
    id: SNAPSHOT,
    tenant_id: TENANT,
    mailbox_id: MAILBOX,
    snapshot_id: SNAPSHOT,
    created_at: '2030-01-01T00:00:00.000Z',
    total_events: entries.length,
    total_size_bytes: 0,
    calendars,
    entries,
  });
}
