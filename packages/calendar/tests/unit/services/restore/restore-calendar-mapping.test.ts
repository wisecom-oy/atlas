import 'reflect-metadata';

import { NotFoundError } from '@wisecom/atlas-types';
import { calendar, calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  SOURCE_CALENDARS,
  TENANT,
  save_snapshot,
  stored_event,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { describe, expect, it } from 'vitest';

import { CalendarRestoreService } from '@/services/restore/restore.service';

/** Restore service over fresh in-memory stores. */
function restore_harness() {
  return calendar_rig(
    (s) => new CalendarRestoreService(s.tenant_factory, s.connector, s.manifests),
  );
}

describe('restore calendar mapping', () => {
  it('rejects a snapshot that is not stored for the mailbox', async () => {
    const rig = restore_harness();

    await expect(
      rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: 'cal-snap-missing' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('restores default calendar events into the target default calendar', async () => {
    const rig = restore_harness();
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual(['cal-default']);
    expect(result.events_restored).toBe(1);
    expect(result.calendars_created).toBe(0);
  });

  it('maps a named calendar onto the writable target calendar of the same name', async () => {
    const rig = restore_harness();
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-work', calendar_event('e-2'))]);

    await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual(['cal-work']);
  });

  it('maps a source calendar onto a target calendar whose name differs only in case', async () => {
    const rig = restore_harness();
    rig.script.calendars = [
      calendar('cal-default', 'Calendar', { is_default: true }),
      calendar('cal-lower-work', 'work'),
    ];
    // Exchange rejects a calendar whose name differs from an existing one only in case.
    rig.script.hooks = { create_calendar: (name) => new Error(`409 ErrorFolderExists: ${name}`) };
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-work', calendar_event('e-w'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.errors).toEqual([]);
    expect(rig.calls.created_calendars).toEqual([]);
    expect(result.calendars_created).toBe(0);
    expect(result.events_restored).toBe(1);
    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual(['cal-lower-work']);
  });

  it('maps a lower-case source calendar onto an upper-case target calendar', async () => {
    const rig = restore_harness();
    rig.script.calendars = [
      calendar('cal-default', 'Calendar', { is_default: true }),
      calendar('cal-upper-hol', 'HOLIDAYS'),
    ];
    const calendars = [
      ...SOURCE_CALENDARS,
      { calendar_id: 'src-hol', display_name: 'holidays', is_default: false },
    ];
    save_snapshot(
      rig.manifests,
      [stored_event(rig.objects, 'src-hol', calendar_event('e-h'))],
      calendars,
    );

    await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.created_calendars).toEqual(['Work']);
    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual(['cal-upper-hol']);
  });

  it('does not write into a read-only target calendar of the same name', async () => {
    const rig = restore_harness();
    rig.script.calendars.push(calendar('cal-birthdays', 'Birthdays', { can_edit: false }));
    const calendars = [
      ...SOURCE_CALENDARS,
      { calendar_id: 'src-bday', display_name: 'Birthdays', is_default: false },
    ];
    save_snapshot(
      rig.manifests,
      [stored_event(rig.objects, 'src-bday', calendar_event('e-b'))],
      calendars,
    );

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(rig.calls.created_calendars).toEqual(['Birthdays']);
    expect(result.calendars_created).toBe(1);
    expect(rig.calls.created_events[0]?.calendar_id).toBe(rig.script.calendars.at(-1)?.id);
  });

  it('creates a missing calendar once and reuses it for later entries', async () => {
    const rig = restore_harness();
    const calendars = [
      ...SOURCE_CALENDARS,
      { calendar_id: 'src-hol', display_name: 'Holidays', is_default: false },
    ];
    save_snapshot(
      rig.manifests,
      [
        stored_event(rig.objects, 'src-hol', calendar_event('e-h1')),
        stored_event(rig.objects, 'src-hol', calendar_event('e-h2')),
      ],
      calendars,
    );

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    const holidays_id = rig.script.calendars.at(-1)?.id;
    expect(rig.calls.created_calendars).toEqual(['Holidays']);
    expect(result.calendars_created).toBe(1);
    expect(result.events_restored).toBe(2);
    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual([holidays_id, holidays_id]);
  });

  it('reports a calendar that cannot be created and still restores the other calendars', async () => {
    const rig = restore_harness();
    rig.script.hooks = { create_calendar: () => new Error('quota exceeded') };
    const calendars = [
      ...SOURCE_CALENDARS,
      { calendar_id: 'src-hol', display_name: 'Holidays', is_default: false },
    ];
    save_snapshot(
      rig.manifests,
      [
        stored_event(rig.objects, 'src-hol', calendar_event('e-hol')),
        stored_event(rig.objects, 'src-default', calendar_event('e-1')),
      ],
      calendars,
    );

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.errors).toEqual([
      'Calendar Holidays could not be created: quota exceeded',
      'Event "Event e-hol" (e-hol) failed to restore: source calendar was not mapped to a target calendar',
    ]);
    expect(result.events_restored).toBe(1);
    expect(rig.calls.created_events.map((c) => c.calendar_id)).toEqual(['cal-default']);
  });

  it('fails default-calendar entries when the target mailbox has no default calendar', async () => {
    const rig = restore_harness();
    rig.script.calendars = [calendar('cal-work', 'Work')];
    save_snapshot(rig.manifests, [stored_event(rig.objects, 'src-default', calendar_event('e-1'))]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.errors).toEqual([
      'The target mailbox has no default calendar',
      'Event "Event e-1" (e-1) failed to restore: source calendar was not mapped to a target calendar',
    ]);
    expect(result.events_restored).toBe(0);
    expect(rig.calls.created_events).toEqual([]);
  });
});
