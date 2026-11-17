import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  SOURCE_ICAL_UID_TAG_ID,
  SOURCE_TAG_ID,
  TENANT,
  save_snapshot,
  stored_event,
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

/** A target event that carries the source-tag property for `source_id`. */
function tagged_target(id: string, source_id: string) {
  return calendar_event(id, {
    iCalUId: `target-${id}`,
    singleValueExtendedProperties: [{ id: SOURCE_TAG_ID, value: source_id }],
  });
}

describe('restore dedupe', () => {
  it('skips an entry whose iCalUId the target calendar already holds', async () => {
    const rig = restore_harness();
    rig.script.target_events['cal-default'] = [calendar_event('t-1', { iCalUId: 'uid-e-1' })];
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_skipped).toBe(1);
    expect(result.events_restored).toBe(0);
    expect(rig.calls.created_events).toEqual([]);
  });

  it('skips an entry whose source tag the target calendar already holds', async () => {
    const rig = restore_harness();
    rig.script.target_events['cal-default'] = [tagged_target('t-1', 'e-1')];
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_skipped).toBe(1);
    expect(rig.calls.created_events).toEqual([]);
  });

  it('restores an entry when the target only holds a different source tag', async () => {
    const rig = restore_harness();
    rig.script.target_events['cal-default'] = [tagged_target('t-1', 'e-9')];
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(1);
    expect(result.events_skipped).toBe(0);
  });

  it('does not count an event held in another calendar as already restored', async () => {
    const rig = restore_harness();
    rig.script.target_events['cal-work'] = [tagged_target('t-1', 'e-1')];
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(1);
    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual(['cal-default']);
  });

  it('creates one event for two entries that share an iCalUId', async () => {
    const rig = restore_harness();
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1', { iCalUId: 'uid-shared' })),
      stored_event(rig.objects, 'src-default', calendar_event('e-2', { iCalUId: 'uid-shared' })),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(1);
    expect(result.events_skipped).toBe(1);
    expect(rig.calls.created_events).toHaveLength(1);
  });

  it('skips an entry whose iCalUId an earlier complete restore recorded', async () => {
    const rig = restore_harness();
    rig.script.target_events['cal-default'] = [
      calendar_event('t-1', {
        iCalUId: 'target-t-1',
        singleValueExtendedProperties: [
          { id: SOURCE_TAG_ID, value: 'e-1' },
          { id: SOURCE_ICAL_UID_TAG_ID, value: 'uid-shared' },
        ],
      }),
    ];
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-2', { iCalUId: 'uid-shared' })),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_skipped).toBe(1);
    expect(rig.calls.created_events).toEqual([]);
  });

  it('lists each target calendar once across all entries bound for it', async () => {
    const rig = restore_harness();
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1')),
      stored_event(rig.objects, 'src-default', calendar_event('e-2')),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(2);
    expect(rig.calls.listed_events).toEqual(['cal-default']);
  });
});
