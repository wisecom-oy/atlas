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

describe('CalendarBackupService outcome', () => {
  it('writes no snapshot for an unchanged run but still saves the advanced cursor', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);

    h.script.deltas['cal-work'] = delta_of('work-2');
    const unchanged = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(unchanged.snapshot).toBeUndefined();
    expect(unchanged.summary.snapshot_created).toBe(false);
    expect(unchanged.summary.no_snapshot_reason).toBe('no_changes');
    expect(h.manifests.saved).toHaveLength(1);
    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar['cal-work']).toBe('work-2');
  });

  it('reports no_content and saves the cursor when nothing has ever been stored', async () => {
    const h = backup_harness();

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_content');
    expect(h.manifests.saved).toEqual([]);
    expect(h.cursors.saved).toHaveLength(1);
  });

  it('names snapshots cal-snap-<ms>-<hex> with the id timestamp matching created_at', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    const match = /^cal-snap-(\d+)-[0-9a-f]+$/.exec(result.snapshot?.snapshot_id ?? '');
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(Date.parse(result.snapshot?.created_at ?? ''));
    expect(result.snapshot?.id).toBe(result.snapshot?.snapshot_id);
  });
});

describe('CalendarBackupService interruption', () => {
  it('writes neither snapshot nor cursor when the abort signal fires during a calendar read', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);
    const saved_manifests = h.manifests.saved.length;
    const saved_cursors = h.cursors.saved.length;

    const controller = new AbortController();
    h.script.hooks = {
      delta: (calendar_id) => {
        if (calendar_id === 'cal-work') controller.abort();
        return undefined;
      },
    };
    h.script.deltas['cal-work'] = delta_of('work-2', [calendar_event('e-new')]);
    const result = await h.service.backup_calendar('tenant-1', MAILBOX, {
      abort_signal: controller.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(h.manifests.saved).toHaveLength(saved_manifests);
    expect(h.cursors.saved).toHaveLength(saved_cursors);
  });

  it('reads nothing and saves nothing when the run is interrupted before it starts', async () => {
    const h = backup_harness();

    const result = await h.service.backup_calendar('tenant-1', MAILBOX, {
      should_interrupt: () => true,
    });

    expect(result.interrupted).toBe(true);
    expect(h.calls.delta).toEqual([]);
    expect(result.snapshot).toBeUndefined();
    expect(h.manifests.saved).toEqual([]);
    expect(h.cursors.saved).toEqual([]);
  });
});
