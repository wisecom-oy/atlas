import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import {
  calendar,
  calendar_event,
  delta_of,
} from '@wisecom/atlas-types/testing/stub-calendar-ports';

import { CalendarBackupService } from '@/services/backup/backup.service';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

/** Backup service over in-memory stores. */
function backup_harness() {
  return calendar_rig(
    (s) => new CalendarBackupService(s.tenant_factory, s.connector, s.manifests, s.cursors),
  );
}

/** Default calendar Graph reports as not editable, next to a writable calendar and a read-only Birthdays calendar. */
function harness() {
  const h = backup_harness();
  h.script.calendars = [
    calendar('cal-default', 'Calendar', { is_default: true, can_edit: false }),
    calendar('cal-birthdays', 'Birthdays', { can_edit: false }),
    calendar('cal-work', 'Work', { can_edit: true }),
  ];
  h.script.deltas['cal-default'] = delta_of('link-default-1', [calendar_event('e-default')]);
  h.script.deltas['cal-work'] = delta_of('link-work-1', [calendar_event('e-work')]);
  return h;
}

describe('CalendarBackupService default calendar', () => {
  it('backs up the default calendar even when Graph reports it as not editable', async () => {
    const h = harness();

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.snapshot).toBeDefined();
    expect(h.manifests.saved).toHaveLength(1);
    expect(result.snapshot?.calendars.map((c) => c.calendar_id)).toContain('cal-default');
    expect(result.snapshot?.entries.find((e) => e.event_id === 'e-default')?.calendar_id).toBe(
      'cal-default',
    );
  });

  it('skips a non-default read-only calendar, counts it, and warns', async () => {
    const h = harness();

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.calls.delta.map((c) => c.calendar_id)).not.toContain('cal-birthdays');
    expect(result.snapshot?.calendars.map((c) => c.calendar_id)).not.toContain('cal-birthdays');
    expect(result.summary.calendars_skipped).toBe(1);
    expect(result.summary.warnings).toEqual(['Calendar Birthdays skipped: read-only']);
  });
});
