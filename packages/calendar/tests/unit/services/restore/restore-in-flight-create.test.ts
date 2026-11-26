/**
 * Issue #879: Ctrl+C while an event create was on the wire aborted it, and the run reported the
 * event as not restored though Graph may have committed it. The create now finishes and counts,
 * the run then stops as interrupted, and a rerun finds the event by its source tag.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  TENANT,
  save_snapshot,
  stored_event,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

import { CREATE_ONCE } from '@/adapters/graph-calendar-requests';
import { CalendarRestoreService } from '@/services/restore/restore.service';

/** Restore service over fresh in-memory stores, with two events in the default calendar. */
function restore_harness() {
  const rig = calendar_rig(
    (s) =>
      new CalendarRestoreService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        stub_owner_leases().leases,
      ),
  );
  save_snapshot(rig.manifests, [
    stored_event(rig.objects, 'src-default', calendar_event('e-1')),
    stored_event(rig.objects, 'src-default', calendar_event('e-2')),
  ]);
  return rig;
}

/** Makes every event create a Graph write that Exchange answers 3 s after it was sent. */
function slow_creates(rig: ReturnType<typeof restore_harness>): void {
  const create = rig.connector.create_event.bind(rig.connector);
  vi.spyOn(rig.connector, 'create_event').mockImplementation((...args) =>
    with_graph_retry(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(create(...args)), 3_000)),
      CREATE_ONCE,
    ),
  );
}

describe('Calendar restore with Ctrl+C during an event create (issue #879)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts the event whose create was on the wire, then stops as interrupted', async () => {
    const rig = restore_harness();
    slow_creates(rig);
    const controller = new AbortController();

    const run = rig.service.restore_calendar(TENANT, MAILBOX, {
      snapshot_id: SNAPSHOT,
      abort_signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await run;

    expect(result.interrupted).toBe(true);
    expect(result.events_restored).toBe(1);
    expect(result.errors).toEqual([]);
    expect(rig.calls.created_events.map((c) => c.payload['subject'])).toEqual(['Event e-1']);
  });

  it('creates no duplicate when the interrupted restore is run again', async () => {
    const rig = restore_harness();
    slow_creates(rig);
    const controller = new AbortController();
    const run = rig.service.restore_calendar(TENANT, MAILBOX, {
      snapshot_id: SNAPSHOT,
      abort_signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(3_000);
    await run;
    vi.restoreAllMocks();
    rig.script.target_events['cal-default'] = rig.calls.created_events.map((c) => ({
      ...c.payload,
      id: c.event_id,
    }));

    const rerun = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rerun.events_skipped).toBe(1);
    expect(rerun.events_restored).toBe(1);
    expect(rig.calls.created_events.map((c) => c.payload['subject'])).toEqual([
      'Event e-1',
      'Event e-2',
    ]);
  });
});
