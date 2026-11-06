import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';

import { CalendarBackupService } from '@/services/backup/backup.service';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

/** Backup service over in-memory stores. */
function backup_harness() {
  return calendar_rig(
    (s) => new CalendarBackupService(s.tenant_factory, s.connector, s.manifests, s.cursors),
  );
}

describe('CalendarBackupService delta reads', () => {
  it('resumes from the stored link and drops events the delta removed', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);

    h.script.deltas['cal-work'] = delta_of('work-2', [], ['e-work']);
    const second = await h.service.backup_calendar('tenant-1', MAILBOX);

    const work_reads = h.calls.delta.filter((c) => c.calendar_id === 'cal-work');
    expect(work_reads.at(-1)).toEqual({ calendar_id: 'cal-work', delta_link: 'work-1' });
    expect(second.snapshot?.entries.map((e) => e.event_id)).not.toContain('e-work');
    expect(second.summary.events_removed).toBe(1);
  });

  it('ignores the stored link on force_full and replaces the calendar entries', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);

    h.script.deltas['cal-work'] = delta_of('work-2', [calendar_event('e-new')]);
    const second = await h.service.backup_calendar('tenant-1', MAILBOX, { force_full: true });

    const work_reads = h.calls.delta.filter((c) => c.calendar_id === 'cal-work');
    expect(work_reads.at(-1)).toEqual({ calendar_id: 'cal-work', delta_link: undefined });
    const work_ids = second.snapshot?.entries
      .filter((e) => e.calendar_id === 'cal-work')
      .map((e) => e.event_id);
    expect(work_ids).toEqual(['e-new']);
  });

  it('replaces a calendar entries when Graph resets its delta', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);

    h.script.deltas['cal-work'] = delta_of('work-2', [calendar_event('e-new')], [], true);
    const second = await h.service.backup_calendar('tenant-1', MAILBOX);

    const work_ids = second.snapshot?.entries
      .filter((e) => e.calendar_id === 'cal-work')
      .map((e) => e.event_id);
    expect(work_ids).toEqual(['e-new']);
    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar['cal-work']).toBe('work-2');
  });

  it('writes a self-contained manifest that carries unchanged events forward', async () => {
    const h = backup_harness();
    h.script.deltas['cal-default'] = delta_of('link-default-1', [calendar_event('e-default')]);
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);

    h.script.deltas['cal-default'] = delta_of('link-default-2');
    h.script.deltas['cal-work'] = delta_of('work-2', [calendar_event('e-new')]);
    const second = await h.service.backup_calendar('tenant-1', MAILBOX);

    const ids = second.snapshot?.entries.map((e) => e.event_id).sort();
    expect(ids).toEqual(['e-default', 'e-new', 'e-work']);
  });
});
