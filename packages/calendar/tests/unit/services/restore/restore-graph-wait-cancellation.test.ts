/**
 * Issue #673: the calendar restore read its abort signal only between events, so Ctrl+C during a
 * create parked in a Graph Retry-After sat the wait out.
 */

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

import { CalendarRestoreService } from '@/services/restore/restore.service';

/** A Graph call throttled with `Retry-After: 360`, which on its own waits six minutes. */
function graph_call_parked_in_retry_wait(): Promise<never> {
  return with_graph_retry(() =>
    Promise.reject({
      statusCode: 429,
      message: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '360' }),
    }),
  );
}

describe('Calendar restore cancelled during a Graph retry wait (issue #673)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the create wait within a second and reports an interrupted restore, not a failed event', async () => {
    const rig = calendar_rig(
      (s) => new CalendarRestoreService(s.tenant_factory, s.connector, s.manifests),
    );
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1')),
      stored_event(rig.objects, 'src-default', calendar_event('e-2')),
    ]);
    const create = vi
      .spyOn(rig.connector, 'create_event')
      .mockImplementation(graph_call_parked_in_retry_wait);
    const controller = new AbortController();
    let settled = false;

    const run = rig.service
      .restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT, abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.errors).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
