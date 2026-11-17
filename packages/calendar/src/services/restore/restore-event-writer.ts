import type { CalendarConnector, CalendarEventEntry, TenantContext } from '@wisecom/atlas-types';

import { build_create_payload } from '@/services/restore/restore-event-payload';
import { replay_recurrence_changes } from '@/services/restore/restore-recurrence';
import { assert_checksum, read_content } from '@/services/shared/content-objects';
import { error_message } from '@/services/shared/error-message';
import { is_record } from '@/services/shared/json-record';
import { is_run_fatal } from '@/services/shared/run-fatal-error';
import { restore_tags_for, source_tag_property } from '@/services/shared/source-tag';

export interface RestoreWriteDeps {
  readonly ctx: TenantContext;
  readonly connector: CalendarConnector;
  readonly tenant_id: string;
  readonly target_mailbox_id: string;
}

/**
 * What a target calendar holds: original events and complete Atlas restores by original iCalUId,
 * complete Atlas restores by source id, and the target event id of each restore an earlier run
 * left incomplete, by source id. Entries restored during the run are added, so a second entry
 * for the same event or iCalUId is skipped.
 */
export interface ExistingEvents {
  readonly ical_uids: Set<string>;
  readonly source_ids: Set<string>;
  readonly incomplete: Map<string, string>;
}

/**
 * A restored event whose exceptions or attachments partly failed still counts as restored;
 * `partial_errors` says what is missing. Such an event keeps its pending tag, so a rerun replaces it.
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

function is_non_empty_array(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Whether restoring the entry writes anything after the create: attachments or series changes. */
function has_follow_up_writes(
  entry: CalendarEventEntry,
  event: Readonly<Record<string, unknown>>,
): boolean {
  if ((entry.attachments ?? []).length > 0) return true;
  return (
    event['type'] === 'seriesMaster' &&
    (is_non_empty_array(event['exceptionOccurrences']) ||
      is_non_empty_array(event['cancelledOccurrences']))
  );
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

/** Adds the complete tag to a fully written event, so later restores skip it. */
async function mark_restore_complete(
  deps: RestoreWriteDeps,
  source_event_id: string,
  event_id: string,
): Promise<string[]> {
  try {
    await deps.connector.update_event(deps.tenant_id, deps.target_mailbox_id, event_id, {
      singleValueExtendedProperties: [source_tag_property(source_event_id)],
    });
    return [];
  } catch (err) {
    if (is_run_fatal(err)) throw err;
    return [`it was not marked as complete: ${error_message(err)}`];
  }
}

/**
 * Replays series changes and uploads attachments onto the created event, then tags it complete.
 * Any failure leaves the pending tag in place and is returned as a message.
 */
async function write_follow_up(
  deps: RestoreWriteDeps,
  entry: CalendarEventEntry,
  event: Readonly<Record<string, unknown>>,
  event_id: string,
): Promise<string[]> {
  const failures = [
    ...(event['type'] === 'seriesMaster'
      ? await replay_recurrence_changes(deps, event, event_id)
      : []),
    ...(await restore_attachments(deps, entry, event_id)),
  ];
  if (failures.length > 0) return failures;
  return mark_restore_complete(deps, entry.event_id, event_id);
}

/** Deletes the event an earlier run created for this source event but never completed. */
async function delete_incomplete_restore(
  deps: RestoreWriteDeps,
  source_event_id: string,
  existing: ExistingEvents,
): Promise<void> {
  const incomplete_id = existing.incomplete.get(source_event_id);
  if (incomplete_id === undefined) return;
  await deps.connector.delete_event(deps.tenant_id, deps.target_mailbox_id, incomplete_id);
  existing.incomplete.delete(source_event_id);
}

/** Records a created event so a later entry for the same source event or iCalUId is skipped. */
function record_restored(
  existing: ExistingEvents,
  source_event_id: string,
  ical_uid: string | undefined,
): void {
  existing.source_ids.add(source_event_id);
  if (ical_uid !== undefined) existing.ical_uids.add(ical_uid);
}

/**
 * Restores one manifest entry into a target calendar. An event the calendar already holds (same
 * iCalUId, or restored completely earlier from the same source event) is skipped, so restore
 * never duplicates or overwrites. An event an earlier run left incomplete is deleted and
 * recreated. The created event carries no attendees, so nobody is notified.
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

  await delete_incomplete_restore(deps, entry.event_id, existing);
  const follow_up = has_follow_up_writes(entry, event);
  const tags = restore_tags_for(entry.event_id, ical_uid, follow_up ? 'pending' : 'complete');
  const event_id = await deps.connector.create_event(
    deps.tenant_id,
    deps.target_mailbox_id,
    calendar_id,
    build_create_payload(event, tags),
  );
  record_restored(existing, entry.event_id, ical_uid);
  const partial_errors = follow_up ? await write_follow_up(deps, entry, event, event_id) : [];
  return { status: 'restored', partial_errors };
}
