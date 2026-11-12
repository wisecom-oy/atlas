import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

import { CalendarBackupService } from '@/services/backup/backup.service';

/**
 * Issue #704, reproduced live on Calendar: after `delete -s` of the newest snapshot the cursor still
 * pointed past the run that wrote it. The next backup built on the older manifest, trusted the
 * cursor, reported no changes, and the changed event was missing from every later snapshot.
 */
function backup_harness() {
  return calendar_rig(
    (s) => new CalendarBackupService(s.tenant_factory, s.connector, s.manifests, s.cursors),
  );
}

describe('a calendar backup after the newest snapshot was deleted', () => {
  it('reads every calendar in full and captures what the deleted snapshot held', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);
    h.script.deltas['cal-work'] = delta_of('work-2', [calendar_event('e-added')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);
    expect(h.manifests.saved).toHaveLength(2);

    // delete -s of the newest snapshot: the manifest goes, a cursor naming it is left behind.
    h.manifests.saved.pop();
    const reads_before = h.calls.delta.length;
    h.script.deltas['cal-work'] = delta_of('work-3', [
      calendar_event('e-work'),
      calendar_event('e-added'),
    ]);
    const third = await h.service.backup_calendar('tenant-1', MAILBOX);

    const reads = h.calls.delta.slice(reads_before);
    expect(reads.every((read) => read.delta_link === undefined)).toBe(true);
    expect(third.summary.snapshot_created).toBe(true);
    expect(third.snapshot?.entries.map((e) => e.event_id)).toContain('e-added');
  });

  it('binds the saved cursor to the snapshot the run wrote, or to the head it kept', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    const first = await h.service.backup_calendar('tenant-1', MAILBOX);
    expect(h.cursors.saved.at(-1)?.snapshot_id).toBe(first.snapshot?.snapshot_id);

    h.script.deltas['cal-work'] = delta_of('work-2');
    const quiet = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(quiet.snapshot).toBeUndefined();
    expect(h.cursors.saved.at(-1)?.snapshot_id).toBe(first.snapshot?.snapshot_id);
    expect(h.calls.delta.at(-1)?.delta_link).toBe('work-1');
  });
});
