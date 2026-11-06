import type { CalendarConnector, CalendarEventEntry, TenantContext } from '@wisecom/atlas-types';

import { build_create_payload } from '@/services/restore/restore-event-payload';
import { replay_recurrence_changes } from '@/services/restore/restore-recurrence';
import { assert_checksum, read_content } from '@/services/shared/content-objects';
import { error_message } from '@/services/shared/error-message';
import { is_record } from '@/services/shared/json-record';
import { is_run_fatal } from '@/services/shared/run-fatal-error';

export interface RestoreWriteDeps {
  readonly ctx: TenantContext;
  readonly connector: CalendarConnector;
  readonly tenant_id: string;
  readonly target_mailbox_id: string;
}

/** What a target calendar already holds: original events by iCalUId, and Atlas restores by source id. */
export interface ExistingEvents {
  readonly ical_uids: Set<string>;
  readonly source_ids: Set<string>;
}

/**
 * A restored event whose exceptions or attachments partly failed still counts as restored;
 * `partial_errors` says what is missing, because a rerun would skip the event and never retry.
 */
export type EntryOutcome =
  | { readonly status: 'skipped' }
  | { readonly status: 'restored'; readonly partial_errors: readonly string[] };

async function read_event(
  ctx: TenantContext,
  entry: CalendarEventEntry,
): Promise<Readonly<Record<string, unknown>>> {
  const bytes = await read_content(ctx, entry.storage_key);
  assert_checksum(ctx, bytes, entry.checksum, 'Event object');
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!is_record(parsed)) throw new Error('Event object is not a JSON object');
  return parsed;
}

/** Uploads every stored file attachment onto the restored event, returning one message per failure. */
async function restore_attachments(
  deps: RestoreWriteDeps,
  entry: CalendarEventEntry,
  event_id: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const attachment of entry.attachments ?? []) {
    try {
      const content = await read_content(deps.ctx, attachment.storage_key);
      assert_checksum(deps.ctx, content, attachment.checksum, 'Attachment');
      await deps.connector.upload_event_attachment(
        deps.tenant_id,
        deps.target_mailbox_id,
        event_id,
        {
          name: attachment.name,
          content_type: attachment.content_type,
          is_inline: attachment.is_inline,
          content_id: attachment.content_id,
          content,
        },
      );
    } catch (err) {
      if (is_run_fatal(err)) throw err;
      failures.push(`attachment "${attachment.name}" not restored: ${error_message(err)}`);
    }
  }
  return failures;
}

/**
 * Restores one manifest entry into a target calendar. An event the calendar already holds (same
 * iCalUId, or restored earlier from the same source event) is skipped, so restore never
 * duplicates or overwrites. The created event carries no attendees, so nobody is notified.
 */
export async function restore_entry(
  deps: RestoreWriteDeps,
  entry: CalendarEventEntry,
  calendar_id: string,
  existing: ExistingEvents,
): Promise<EntryOutcome> {
  const event = await read_event(deps.ctx, entry);
  const ical_uid = typeof event['iCalUId'] === 'string' ? event['iCalUId'] : undefined;
  if (existing.source_ids.has(entry.event_id)) return { status: 'skipped' };
  if (ical_uid !== undefined && existing.ical_uids.has(ical_uid)) return { status: 'skipped' };

  const event_id = await deps.connector.create_event(
    deps.tenant_id,
    deps.target_mailbox_id,
    calendar_id,
    build_create_payload(event, entry.event_id),
  );
  existing.source_ids.add(entry.event_id);
  const partial_errors = [
    ...(event['type'] === 'seriesMaster'
      ? await replay_recurrence_changes(deps, event, event_id)
      : []),
    ...(await restore_attachments(deps, entry, event_id)),
  ];
  return { status: 'restored', partial_errors };
}
