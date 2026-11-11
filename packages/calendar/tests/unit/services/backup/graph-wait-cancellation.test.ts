/**
 * Issue #673: the calendar backup read its abort signal only between events, so Ctrl+C during a
 * delta read parked in a Graph Retry-After sat the wait out.
 */

import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

import { CalendarBackupService } from '@/services/backup/backup.service';

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

describe('Calendar backup cancelled during a Graph retry wait (issue #673)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the delta read wait within a second and records an interrupted run', async () => {
    const h = calendar_rig(
      (s) => new CalendarBackupService(s.tenant_factory, s.connector, s.manifests, s.cursors),
    );
    vi.spyOn(h.connector, 'fetch_event_delta').mockImplementation(graph_call_parked_in_retry_wait);
    const controller = new AbortController();
    let settled = false;

    const run = h.service
      .backup_calendar('tenant-1', MAILBOX, { abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.summary.errors).toEqual([]);
    expect(h.cursors.saved).toEqual([]);
  });
});
