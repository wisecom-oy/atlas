import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';

import { CalendarBackupService } from '@/services/backup/backup.service';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

/** Backup service over in-memory stores. */
function backup_harness() {
  return calendar_rig(
    (s) =>
      new CalendarBackupService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        s.cursors,
        stub_owner_leases().leases,
      ),
  );
}

const FILE = { id: 'a1', name: 'agenda.pdf', kind: 'file', is_inline: false, size: 3 } as const;

describe('CalendarBackupService skipped attachments', () => {
  it('counts item and reference attachments and reports the run unhealthy', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-att', { hasAttachments: true }),
    ]);
    h.script.attachments['e-att'] = [
      FILE,
      { id: 'i1', name: 'Forwarded', kind: 'item', is_inline: false, size: 0 },
      { id: 'r1', name: 'Shared link', kind: 'reference', is_inline: false, size: 0 },
    ];
    h.script.attachment_bytes['a1'] = Buffer.from('abc');

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.attachments_skipped).toBe(2);
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.warnings).toEqual([
      'Event "Event e-att" (e-att) in Work: item attachment "Forwarded" is not captured',
      'Event "Event e-att" (e-att) in Work: reference attachment "Shared link" is not captured',
    ]);
    expect(result.snapshot?.entries.find((e) => e.event_id === 'e-att')?.attachments).toHaveLength(
      1,
    );
  });

  it('counts each recurrence exception that carries attachments', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('s-1', { type: 'seriesMaster' }),
    ]);
    h.script.series_masters['s-1'] = calendar_event('s-1', {
      type: 'seriesMaster',
      exceptionOccurrences: [
        { id: 'x-1', hasAttachments: true },
        { id: 'x-2', hasAttachments: false },
        { id: 'x-3', hasAttachments: true },
      ],
    });

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.attachments_skipped).toBe(2);
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.warnings).toEqual([
      'Event "Event s-1" (s-1) in Work: attachments on 2 recurrence exception(s) are not captured',
    ]);
  });

  it('still advances the delta link, since a rerun cannot capture them either', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-att', { hasAttachments: true }),
    ]);
    h.script.attachments['e-att'] = [
      { id: 'i1', name: 'Forwarded', kind: 'item', is_inline: false, size: 0 },
    ];

    await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar['cal-work']).toBe('work-1');
  });

  it('stays healthy when every attachment is a file', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-att', { hasAttachments: true }),
    ]);
    h.script.attachments['e-att'] = [FILE];
    h.script.attachment_bytes['a1'] = Buffer.from('abc');

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.attachments_skipped).toBe(0);
    expect(result.summary.healthy).toBe(true);
  });
});
