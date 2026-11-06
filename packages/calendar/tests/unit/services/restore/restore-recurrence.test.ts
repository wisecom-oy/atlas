import 'reflect-metadata';

import type { CalendarRestoreResult, GraphEventPayload } from '@wisecom/atlas-types';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import type { CalendarRig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  TENANT,
  save_snapshot,
  stored_event,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { describe, expect, it } from 'vitest';

import { CalendarRestoreService } from '@/services/restore/restore.service';

/** The first event id the fake connector issues, which is the restored series master. */
const SERIES_ID = 'evt-new-1';

/** Restore service over fresh in-memory stores. */
function restore_harness() {
  return calendar_rig(
    (s) => new CalendarRestoreService(s.tenant_factory, s.connector, s.manifests),
  );
}

/** Saves a series master as the snapshot and restores it into the default calendar. */
async function restore_series(
  rig: CalendarRig<CalendarRestoreService>,
  master: GraphEventPayload,
): Promise<CalendarRestoreResult> {
  save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', master)]);
  return rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });
}

/** A weekly series master in Europe/Berlin with the given exceptions and cancellations. */
function series(fields: Record<string, unknown>): GraphEventPayload {
  return calendar_event('e-series', {
    type: 'seriesMaster',
    subject: 'Standup',
    start: { dateTime: '2030-01-20T09:00:00', timeZone: 'Europe/Berlin' },
    ...fields,
  });
}

/** A restored occurrence of the series, as `list_series_instances` returns it. */
function occurrence(id: string, type: string, original: string, day: string): GraphEventPayload {
  return calendar_event(id, {
    type,
    originalStart: original,
    start: { dateTime: `${day}T10:00:00.0000000`, timeZone: 'Europe/Berlin' },
  });
}

describe('restore recurrence replay', () => {
  it('patches the occurrence matching the exception instant and queries a window around it', async () => {
    const rig = restore_harness();
    rig.script.instances[SERIES_ID] = [
      occurrence('inst-2', 'occurrence', '2030-01-21T09:00:00Z', '2030-01-21'),
      occurrence('inst-1', 'occurrence', '2030-01-20T09:00:00Z', '2030-01-20'),
    ];
    const exception = {
      originalStart: '2030-01-20T09:00:00Z',
      subject: 'Standup moved',
      start: { dateTime: '2030-01-20T11:00:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2030-01-20T11:15:00', timeZone: 'Europe/Berlin' },
      attendees: [],
      id: 'AAMk-exception',
      type: 'exception',
      recurrence: null,
    };

    const result = await restore_series(rig, series({ exceptionOccurrences: [exception] }));

    const instant = Date.parse('2030-01-20T09:00:00Z');
    const query = rig.calls.instance_queries[0];
    expect(result.errors).toEqual([]);
    expect(query?.series_id).toBe(SERIES_ID);
    expect(query?.window.time_zone).toBe('Europe/Berlin');
    expect(Date.parse(query?.window.start ?? '')).toBeLessThanOrEqual(instant);
    expect(Date.parse(query?.window.end ?? '')).toBeGreaterThan(instant);
    expect(rig.calls.patches).toEqual([
      {
        event_id: 'inst-1',
        patch: {
          subject: 'Standup moved',
          start: { dateTime: '2030-01-20T11:00:00', timeZone: 'Europe/Berlin' },
          end: { dateTime: '2030-01-20T11:15:00', timeZone: 'Europe/Berlin' },
        },
      },
    ]);
  });

  it('reports an exception whose occurrence is missing and keeps the series restored', async () => {
    const rig = restore_harness();
    rig.script.instances[SERIES_ID] = [
      occurrence('inst-2', 'occurrence', '2030-01-21T09:00:00Z', '2030-01-21'),
    ];
    const exception = { originalStart: '2030-01-20T09:00:00Z', subject: 'Moved' };

    const result = await restore_series(rig, series({ exceptionOccurrences: [exception] }));

    expect(result.events_restored).toBe(1);
    expect(result.errors).toEqual([
      'Event "Standup" (e-series) restored, but exception 2030-01-20T09:00:00Z not applied: no occurrence at 2030-01-20T09:00:00Z in the restored series',
    ]);
    expect(rig.calls.patches).toEqual([]);
  });

  it('deletes only the occurrence on a cancelled date, not the series master listed there', async () => {
    const rig = restore_harness();
    rig.script.instances[SERIES_ID] = [
      occurrence('inst-m', 'seriesMaster', '2030-01-20T09:00:00Z', '2030-01-20'),
      occurrence('inst-o', 'occurrence', '2030-01-20T09:00:00Z', '2030-01-20'),
      occurrence('inst-x', 'occurrence', '2030-01-21T09:00:00Z', '2030-01-21'),
    ];

    const result = await restore_series(
      rig,
      series({ cancelledOccurrences: ['OID.AAMk-series.2030-01-20'] }),
    );

    expect(result.errors).toEqual([]);
    expect(rig.calls.deleted_occurrences).toEqual(['inst-o']);
  });

  it('reports a cancelled date with no occurrence and keeps the series restored', async () => {
    const rig = restore_harness();
    rig.script.instances[SERIES_ID] = [
      occurrence('inst-x', 'occurrence', '2030-01-21T09:00:00Z', '2030-01-21'),
    ];

    const result = await restore_series(
      rig,
      series({ cancelledOccurrences: ['OID.AAMk-series.2030-01-20'] }),
    );

    expect(result.events_restored).toBe(1);
    expect(result.errors).toEqual([
      'Event "Standup" (e-series) restored, but cancellation on 2030-01-20 not applied: no occurrence on 2030-01-20 in the restored series',
    ]);
    expect(rig.calls.deleted_occurrences).toEqual([]);
  });

  it('still applies a cancellation after an exception fails', async () => {
    const rig = restore_harness();
    rig.script.instances[SERIES_ID] = [
      occurrence('inst-o', 'occurrence', '2030-01-22T09:00:00Z', '2030-01-22'),
    ];

    const result = await restore_series(
      rig,
      series({
        exceptionOccurrences: [{ originalStart: '2030-01-20T09:00:00Z', subject: 'Moved' }],
        cancelledOccurrences: ['OID.AAMk-series.2030-01-22'],
      }),
    );

    expect(result.errors).toEqual([
      'Event "Standup" (e-series) restored, but exception 2030-01-20T09:00:00Z not applied: no occurrence at 2030-01-20T09:00:00Z in the restored series',
    ]);
    expect(rig.calls.deleted_occurrences).toEqual(['inst-o']);
  });
});
