import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import type { GraphEventPayload } from '@wisecom/atlas-types';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  PENDING_TAG_ID,
  SNAPSHOT,
  SOURCE_ICAL_UID_TAG_ID,
  SOURCE_TAG_ID,
  TENANT,
  save_snapshot,
  stored_event,
  stored_file,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { describe, expect, it } from 'vitest';

import { CalendarRestoreService } from '@/services/restore/restore.service';

/** Restore service over fresh in-memory stores. */
function restore_harness() {
  return calendar_rig(
    (s) =>
      new CalendarRestoreService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        stub_owner_leases().leases,
      ),
  );
}

type Rig = ReturnType<typeof restore_harness>;

/** Seeds a snapshot holding one event `e-1` with one file attachment. */
function seed_event_with_attachment(rig: Rig): void {
  const file = stored_file(rig.objects, 'att-1', 'agenda.pdf', 'PDF-BYTES');
  save_snapshot(rig.manifests, [
    stored_event(rig.objects, 'src-default', calendar_event('e-1'), [file]),
  ]);
}

/** The events a run created, as the next run's listing of the default calendar returns them. */
function created_as_listed(rig: Rig): GraphEventPayload[] {
  return rig.calls.created_events.map((created) =>
    calendar_event(created.event_id, {
      iCalUId: `target-${created.event_id}`,
      singleValueExtendedProperties: created.payload['singleValueExtendedProperties'],
    }),
  );
}

function restore(rig: Rig) {
  return rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });
}

describe('restore of an incomplete event', () => {
  it('creates an event with attachments under the pending tag and tags it complete after', async () => {
    const rig = restore_harness();
    seed_event_with_attachment(rig);

    const result = await restore(rig);

    expect(result.errors).toEqual([]);
    expect(rig.calls.created_events[0]?.payload['singleValueExtendedProperties']).toEqual([
      { id: PENDING_TAG_ID, value: 'e-1' },
      { id: SOURCE_ICAL_UID_TAG_ID, value: 'uid-e-1' },
    ]);
    expect(rig.calls.uploads).toHaveLength(1);
    expect(rig.calls.patches).toEqual([
      {
        event_id: 'evt-new-1',
        patch: { singleValueExtendedProperties: [{ id: SOURCE_TAG_ID, value: 'e-1' }] },
      },
    ]);
  });

  it('leaves an event whose attachment upload failed without the complete tag', async () => {
    const rig = restore_harness();
    rig.script.hooks = { upload_attachment: () => new Error('upload refused') };
    seed_event_with_attachment(rig);

    const result = await restore(rig);

    expect(result.events_restored).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(rig.calls.patches).toEqual([]);
  });

  it('replaces the incomplete event on the next run and completes its attachments', async () => {
    const rig = restore_harness();
    rig.script.hooks = { upload_attachment: () => new Error('upload refused') };
    seed_event_with_attachment(rig);
    await restore(rig);
    rig.script.target_events['cal-default'] = created_as_listed(rig);
    rig.script.hooks = {};

    const rerun = await restore(rig);

    expect(rerun.events_restored).toBe(1);
    expect(rerun.events_skipped).toBe(0);
    expect(rerun.errors).toEqual([]);
    expect(rig.calls.deleted_events).toEqual(['evt-new-1']);
    expect(rig.calls.uploads.map((u) => u.event_id)).toEqual(['evt-new-2']);
    expect(rig.calls.patches.map((p) => p.event_id)).toEqual(['evt-new-2']);
  });

  it('skips an event a completed earlier run tagged with both tags', async () => {
    const rig = restore_harness();
    seed_event_with_attachment(rig);
    rig.script.target_events['cal-default'] = [
      calendar_event('t-1', {
        iCalUId: 'target-t-1',
        singleValueExtendedProperties: [
          { id: PENDING_TAG_ID, value: 'e-1' },
          { id: SOURCE_TAG_ID, value: 'e-1' },
        ],
      }),
    ];

    const result = await restore(rig);

    expect(result.events_skipped).toBe(1);
    expect(rig.calls.deleted_events).toEqual([]);
    expect(rig.calls.created_events).toEqual([]);
  });

  it('reports an event whose complete tag could not be written and keeps it restored', async () => {
    const rig = restore_harness();
    rig.script.hooks = { update_event: () => new Error('patch refused') };
    seed_event_with_attachment(rig);

    const result = await restore(rig);

    expect(result.events_restored).toBe(1);
    expect(result.errors).toEqual([
      'Event "Event e-1" (e-1) restored, but it was not marked as complete: patch refused',
    ]);
  });

  it('creates an event with nothing to add afterwards under the complete tag at once', async () => {
    const rig = restore_harness();
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    await restore(rig);

    expect(rig.calls.created_events[0]?.payload['singleValueExtendedProperties']).toEqual([
      { id: SOURCE_TAG_ID, value: 'e-1' },
      { id: SOURCE_ICAL_UID_TAG_ID, value: 'uid-e-1' },
    ]);
    expect(rig.calls.patches).toEqual([]);
  });
});
