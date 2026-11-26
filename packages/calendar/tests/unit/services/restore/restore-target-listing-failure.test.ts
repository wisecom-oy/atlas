/**
 * Issue #886: a target calendar whose event listing failed after its retries was listed again for
 * every entry, each with a fresh retry budget, so one calendar in an outage cost one budget per
 * event. The failure is now remembered for the run and reported against each of its entries.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import { AuthError, GraphUnavailableError } from '@wisecom/atlas-types';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
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

/** The error a listing gets once every retry of a sustained 503 is spent. */
function exhausted_listing(): GraphUnavailableError {
  return new GraphUnavailableError(
    'Microsoft Graph kept failing after 12 retries: 503 ServiceUnavailable',
    { retries: 12, elapsed_ms: 1_411_000 },
    { status_code: 503 },
  );
}

/** Three default-calendar events and one in `Work`, so each target calendar holds entries. */
function save_two_calendars(rig: ReturnType<typeof restore_harness>): void {
  save_snapshot(rig.manifests, [
    stored_event(rig.objects, 'src-default', calendar_event('e-1')),
    stored_event(rig.objects, 'src-default', calendar_event('e-2')),
    stored_event(rig.objects, 'src-work', calendar_event('w-1')),
    stored_event(rig.objects, 'src-default', calendar_event('e-3')),
  ]);
}

describe('Calendar restore when a target calendar cannot be listed (issue #886)', () => {
  it('lists the failed calendar once, not once per entry', async () => {
    const rig = restore_harness();
    save_two_calendars(rig);
    rig.script.hooks = {
      list_events: (calendar_id) =>
        calendar_id === 'cal-default' ? exhausted_listing() : undefined,
    };

    await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.listed_events.filter((id) => id === 'cal-default')).toHaveLength(1);
  });

  it("reports each of the calendar's entries as failed, naming the listing failure", async () => {
    const rig = restore_harness();
    save_two_calendars(rig);
    rig.script.hooks = {
      list_events: (calendar_id) =>
        calendar_id === 'cal-default' ? exhausted_listing() : undefined,
    };

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.errors).toHaveLength(3);
    for (const [index, id] of ['e-1', 'e-2', 'e-3'].entries()) {
      expect(result.errors[index]).toBe(
        `Event "Event ${id}" (${id}) failed to restore: could not list the events in the ` +
          'target calendar: Microsoft Graph kept failing after 12 retries: 503 ServiceUnavailable',
      );
    }
  });

  it('still restores the other calendars of the run', async () => {
    const rig = restore_harness();
    save_two_calendars(rig);
    rig.script.hooks = {
      list_events: (calendar_id) =>
        calendar_id === 'cal-default' ? exhausted_listing() : undefined,
    };

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(1);
    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual(['cal-work']);
  });

  it('never takes a failed listing as an empty calendar', async () => {
    const rig = restore_harness();
    save_two_calendars(rig);
    rig.script.hooks = { list_events: () => exhausted_listing() };

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.created_events).toEqual([]);
    expect(result.events_restored).toBe(0);
    expect(result.events_skipped).toBe(0);
  });

  it('still ends the run on an AuthError from the listing', async () => {
    const rig = restore_harness();
    save_two_calendars(rig);
    rig.script.hooks = { list_events: () => new AuthError('Calendars.ReadWrite is not granted') };

    await expect(
      rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(rig.calls.listed_events).toHaveLength(1);
  });
});
