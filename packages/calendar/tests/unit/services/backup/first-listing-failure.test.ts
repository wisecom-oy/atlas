/**
 * Where a "not found" stops a Calendar backup (issue #864).
 *
 * The calendar listing decides whether the run happens, so its failure ends the run with nothing
 * written; the connector has already confirmed it, and the error's class carries the exit code. A
 * 404 on one calendar's delta after the listing fails only that calendar, which the CLI reports as
 * a partial run with exit `2`.
 */

import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import {
  calendar,
  calendar_event,
  delta_of,
} from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { CalendarBackupService } from '@/services/backup/backup.service';

/** Backup service over in-memory stores, with two calendars that each hold one event. */
function harness() {
  const h = calendar_rig(
    (s) =>
      new CalendarBackupService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        s.cursors,
        stub_owner_leases().leases,
      ),
  );
  h.script.calendars = [
    calendar('cal-default', 'Calendar', { is_default: true }),
    calendar('cal-work', 'Work'),
  ];
  h.script.deltas = {
    'cal-default': delta_of('default-1', [calendar_event('e-default')]),
    'cal-work': delta_of('work-1', [calendar_event('e-work')]),
  };
  return h;
}

describe('Calendar backup and a "not found" answer (issue #864)', () => {
  it('ends the run with the listing failure and writes nothing', async () => {
    const h = harness();
    const unavailable = new GraphUnavailableError('kept answering 404', {
      retries: 2,
      elapsed_ms: 6_000,
    });
    vi.spyOn(h.connector, 'list_calendars').mockRejectedValue(unavailable);

    await expect(h.service.backup_calendar('tenant-1', MAILBOX)).rejects.toBe(unavailable);
    expect(h.manifests.saved).toHaveLength(0);
    expect(h.cursors.saved).toHaveLength(0);
  });

  it('fails only the calendar whose delta answers 404, and stores the others', async () => {
    const h = harness();
    const read_delta = h.connector.fetch_event_delta.bind(h.connector);
    vi.spyOn(h.connector, 'fetch_event_delta').mockImplementation((...args) =>
      args[2] === 'cal-work'
        ? Promise.reject(graph_error(404, 'ErrorItemNotFound'))
        : read_delta(...args),
    );

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toMatch(/^Calendar Work failed: /);
    const entries = h.manifests.saved.at(-1)?.entries ?? [];
    expect(entries.map((entry) => entry.event_id)).toEqual(['e-default']);
  });
});
