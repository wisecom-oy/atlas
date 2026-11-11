import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';

import { CalendarBackupService } from '@/services/backup/backup.service';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

const DAMAGED_KEY = `calendar/manifests/${MAILBOX}/cal-snap-9999-abc.json`;

function backup_harness() {
  return calendar_rig(
    (s) => new CalendarBackupService(s.tenant_factory, s.connector, s.manifests, s.cursors),
  );
}

describe('CalendarBackupService when the newest manifest is unreadable (issue #631)', () => {
  it('reads every calendar in full, writes a fresh snapshot and names the damaged key', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    const first = await h.service.backup_calendar('tenant-1', MAILBOX);
    h.manifests.find_latest_readable = async () => ({
      manifest: first.snapshot,
      unreadable_keys: [DAMAGED_KEY],
    });
    h.script.deltas['cal-work'] = delta_of('work-2', [calendar_event('e-work')]);

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    const work_reads = h.calls.delta.filter((c) => c.calendar_id === 'cal-work');
    expect(work_reads.at(-1)).toEqual({ calendar_id: 'cal-work', delta_link: undefined });
    expect(result.snapshot?.entries.map((e) => e.event_id)).toContain('e-work');
    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
  });

  it('reports nothing for a run whose newest manifest reads cleanly', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.unreadable_keys).toBeUndefined();
  });
});
