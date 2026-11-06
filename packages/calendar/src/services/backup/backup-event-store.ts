import { compute_content_digests } from '@wisecom/atlas-core/services/shared/content-digests';
import type {
  CalendarAttachmentRecord,
  CalendarConnector,
  CalendarEventEntry,
  GraphEventPayload,
  TenantContext,
} from '@wisecom/atlas-types';
import { put_content_if_absent } from '@/services/shared/content-objects';
import { is_record } from '@/services/shared/json-record';
import { calendar_attachment_key, calendar_data_key } from '@/services/shared/storage-keys';

/** Shared inputs for storing the events of one mailbox. */
export interface EventStoreDeps {
  readonly ctx: TenantContext;
  readonly connector: CalendarConnector;
  readonly tenant_id: string;
  readonly mailbox_id: string;
}

/** Objects an event contributed, the manifest entry that points at them, and what was left out. */
export interface StoredEvent {
  readonly entry: CalendarEventEntry;
  readonly objects_stored: number;
  readonly warnings: readonly string[];
}

/**
 * The zone a series is defined in. Its occurrences keep their wall-clock time across daylight
 * saving changes only when the master is restored in this zone rather than in UTC.
 */
export function series_time_zone(event: GraphEventPayload): string {
  const recurrence = event['recurrence'];
  if (is_record(recurrence) && is_record(recurrence['range'])) {
    const zone = recurrence['range']['recurrenceTimeZone'];
    if (typeof zone === 'string' && zone !== '') return zone;
  }
  const original = event['originalStartTimeZone'];
  return typeof original === 'string' && original !== '' ? original : 'UTC';
}

/** Whether Graph rejected the request itself, as it does for a zone Exchange cannot use. */
function is_bad_request(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 400;
}

/**
 * The payload to store. A series master is re-read with its exceptions and cancellations in its
 * own zone; a zone Exchange rejects (400, for example a custom zone) falls back to UTC.
 */
async function payload_to_store(
  deps: EventStoreDeps,
  event: GraphEventPayload,
): Promise<GraphEventPayload> {
  if (event['type'] !== 'seriesMaster') return event;
  const { connector, tenant_id, mailbox_id } = deps;
  const zone = series_time_zone(event);
  try {
    return await connector.fetch_series_master(tenant_id, mailbox_id, event.id, zone);
  } catch (err) {
    if (zone === 'UTC' || !is_bad_request(err)) throw err;
    return connector.fetch_series_master(tenant_id, mailbox_id, event.id, 'UTC');
  }
}

function string_or_undefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface StoredAttachments {
  readonly records: CalendarAttachmentRecord[];
  readonly objects_stored: number;
  readonly warnings: string[];
}

/** Stores the event's file attachments; other attachment kinds are reported, not stored. */
async function store_attachments(
  deps: EventStoreDeps,
  event_id: string,
): Promise<StoredAttachments> {
  const { ctx, connector, tenant_id, mailbox_id } = deps;
  const listed = await connector.list_event_attachments(tenant_id, mailbox_id, event_id);
  const records: CalendarAttachmentRecord[] = [];
  const warnings: string[] = [];
  let objects_stored = 0;
  for (const attachment of listed) {
    if (attachment.kind !== 'file') {
      warnings.push(`${attachment.kind} attachment "${attachment.name}" is not captured`);
      continue;
    }
    const bytes = Buffer.from(
      await connector.fetch_attachment_content(tenant_id, mailbox_id, event_id, attachment.id),
    );
    const digests = compute_content_digests(ctx, bytes);
    const storage_key = calendar_attachment_key(mailbox_id, digests.content_name);
    if (await put_content_if_absent(ctx, storage_key, bytes)) objects_stored += 1;
    records.push({
      attachment_id: attachment.id,
      name: attachment.name,
      content_type: attachment.content_type,
      is_inline: attachment.is_inline,
      content_id: attachment.content_id,
      storage_key,
      checksum: digests.checksum,
      size_bytes: bytes.length,
    });
  }
  return { records, objects_stored, warnings };
}

/** Stores an event's JSON and its file attachments under keyed content names. */
export async function store_event_entry(
  deps: EventStoreDeps,
  calendar_id: string,
  event: GraphEventPayload,
): Promise<StoredEvent> {
  const payload = await payload_to_store(deps, event);
  const data = Buffer.from(JSON.stringify(payload));
  const digests = compute_content_digests(deps.ctx, data);
  const storage_key = calendar_data_key(deps.mailbox_id, digests.content_name);
  let objects_stored = (await put_content_if_absent(deps.ctx, storage_key, data)) ? 1 : 0;
  const attachments =
    payload['hasAttachments'] === true
      ? await store_attachments(deps, event.id)
      : { records: [], objects_stored: 0, warnings: [] };
  objects_stored += attachments.objects_stored;
  const entry: CalendarEventEntry = {
    event_id: event.id,
    calendar_id,
    event_type: string_or_undefined(payload['type']) ?? 'singleInstance',
    subject: string_or_undefined(payload['subject']),
    // The delta payload's start is UTC; the stored master's start is in the series zone.
    start_at: is_record(event['start'])
      ? string_or_undefined(event['start']['dateTime'])
      : undefined,
    last_modified_at: string_or_undefined(payload['lastModifiedDateTime']),
    storage_key,
    checksum: digests.checksum,
    size_bytes: data.length,
    ...(attachments.records.length > 0 ? { attachments: attachments.records } : {}),
  };
  // ponytail: exception-only attachments are reported, not stored; capture them if anyone relies on them.
  const exceptions = Array.isArray(payload['exceptionOccurrences'])
    ? payload['exceptionOccurrences']
    : [];
  const exception_files = exceptions.some((x) => is_record(x) && x['hasAttachments'] === true);
  const warnings = exception_files
    ? [...attachments.warnings, 'attachments on individual recurrence exceptions are not captured']
    : attachments.warnings;
  return { entry, objects_stored, warnings };
}
