import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';

import { CalendarBackupService } from '@/services/backup/backup.service';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

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

const RECURRING = {
  type: 'seriesMaster',
  recurrence: { range: { recurrenceTimeZone: 'Europe/Berlin' } },
};

/** What Graph answers for a `Prefer: outlook.timezone` value Exchange cannot use. */
const ZONE_REJECTED = () =>
  graph_error(400, 'TimeZoneNotSupportedException', 'A valid TimeZone value must be specified.');

describe('CalendarBackupService series masters', () => {
  it('re-reads a series master in its recurrence zone and stores the master payload', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('s-1', RECURRING)]);
    h.script.series_masters['s-1'] = calendar_event('s-1', {
      ...RECURRING,
      subject: 'Standup',
      exceptionOccurrences: [{ originalStart: '2030-01-08T09:00:00Z' }],
    });

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.calls.series_master).toEqual([{ event_id: 's-1', time_zone: 'Europe/Berlin' }]);
    const entry = result.snapshot?.entries.find((e) => e.event_id === 's-1');
    const stored = JSON.parse(h.objects[entry?.storage_key ?? ''].toString());
    expect(stored.subject).toBe('Standup');
    expect(stored.exceptionOccurrences).toEqual([{ originalStart: '2030-01-08T09:00:00Z' }]);
  });

  it.each([
    [
      'originalStartTimeZone',
      { originalStartTimeZone: 'Pacific Standard Time' },
      'Pacific Standard Time',
    ],
    ['neither zone', {}, 'UTC'],
  ])('falls back to %s when the recurrence range has no zone', async (_label, fields, zone) => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('s-1', { type: 'seriesMaster', ...fields }),
    ]);
    h.script.series_masters['s-1'] = calendar_event('s-1', { type: 'seriesMaster' });

    await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.calls.series_master).toEqual([{ event_id: 's-1', time_zone: zone }]);
  });

  it('retries once in UTC when Graph rejects a non-UTC zone as TimeZoneNotSupportedException', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('s-1', RECURRING)]);
    h.script.series_masters['s-1'] = calendar_event('s-1', { type: 'seriesMaster' });
    h.script.hooks = {
      series_master: (_id, zone) => (zone === 'UTC' ? undefined : ZONE_REJECTED()),
    };

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.calls.series_master.map((c) => c.time_zone)).toEqual(['Europe/Berlin', 'UTC']);
    expect(result.snapshot?.entries.map((e) => e.event_id)).toContain('s-1');
    expect(result.summary.errors).toEqual([]);
  });

  it('does not retry past the single UTC attempt when Graph still rejects it', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('s-1', RECURRING)]);
    h.script.hooks = { series_master: ZONE_REJECTED };

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.calls.series_master.map((c) => c.time_zone)).toEqual(['Europe/Berlin', 'UTC']);
    expect(result.summary.errors).toHaveLength(1);
    expect(result.snapshot?.entries.map((e) => e.event_id) ?? []).not.toContain('s-1');
  });

  it('fails the event with Graph message on a 400 that is not about the zone, without a UTC read', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('s-1', RECURRING)]);
    h.script.series_masters['s-1'] = calendar_event('s-1', { type: 'seriesMaster' });
    h.script.hooks = {
      series_master: () => graph_error(400, 'BadRequest', 'Parsing OData Select and Expand failed'),
    };

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.calls.series_master.map((c) => c.time_zone)).toEqual(['Europe/Berlin']);
    expect(result.summary.errors).toEqual([
      'Event "Event s-1" (s-1) in Work failed: Parsing OData Select and Expand failed',
    ]);
    expect(result.summary.healthy).toBe(false);
  });
});

describe('CalendarBackupService attachments', () => {
  it('stores file attachments, warns about the rest, and counts attachment bytes in totals', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-att', { hasAttachments: true }),
    ]);
    h.script.attachments['e-att'] = [
      {
        id: 'a1',
        name: 'agenda.pdf',
        kind: 'file',
        content_type: 'application/pdf',
        is_inline: false,
        size: 3,
      },
      { id: 'i1', name: 'Forwarded', kind: 'item', is_inline: false, size: 0 },
    ];
    h.script.attachment_bytes['a1'] = Buffer.from('abc');

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    const entry = result.snapshot?.entries.find((e) => e.event_id === 'e-att');
    expect(entry?.attachments).toEqual([
      expect.objectContaining({ attachment_id: 'a1', name: 'agenda.pdf', size_bytes: 3 }),
    ]);
    const stored = h.objects[entry?.attachments?.[0]?.storage_key ?? ''];
    expect(stored.toString()).toBe('abc');
    expect(result.summary.warnings).toEqual([
      'Event "Event e-att" (e-att) in Work: item attachment "Forwarded" is not captured',
    ]);
    expect(result.snapshot?.total_events).toBe(result.snapshot?.entries.length);
    expect(result.snapshot?.total_size_bytes).toBe((entry?.size_bytes ?? 0) + 3);
  });
});
