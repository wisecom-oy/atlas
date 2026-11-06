import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { AuthError, MailboxNotLicensedError } from '@wisecom/atlas-types';

import { CalendarBackupService } from '@/services/backup/backup.service';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

/** Backup service over in-memory stores. */
function backup_harness() {
  return calendar_rig(
    (s) => new CalendarBackupService(s.tenant_factory, s.connector, s.manifests, s.cursors),
  );
}

const WITH_FILE = { hasAttachments: true };

describe('CalendarBackupService failures', () => {
  it('keeps the previous entry and the old link when an event fails, so it is retried', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    const first = await h.service.backup_calendar('tenant-1', MAILBOX);
    const previous_key = first.snapshot?.entries.find((e) => e.event_id === 'e-work')?.storage_key;

    h.script.deltas['cal-work'] = delta_of('work-2', [
      calendar_event('e-work', { ...WITH_FILE, subject: 'Changed' }),
    ]);
    h.script.attachments['e-work'] = [
      { id: 'a1', name: 'agenda.pdf', kind: 'file', is_inline: false, size: 3 },
    ];
    h.script.hooks = { attachment_content: () => new Error('storage timeout') };
    const failed = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(failed.summary.errors).toEqual([
      'Event "Changed" (e-work) in Work failed: storage timeout',
    ]);
    expect(failed.summary.healthy).toBe(false);
    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar['cal-work']).toBe('work-1');

    h.script.attachment_bytes['a1'] = new TextEncoder().encode('PDF');
    h.script.hooks = {};
    h.script.deltas['cal-work'] = delta_of('work-3', [
      calendar_event('e-work', { ...WITH_FILE, subject: 'Changed' }),
    ]);
    const retried = await h.service.backup_calendar('tenant-1', MAILBOX);

    const work_reads = h.calls.delta.filter((c) => c.calendar_id === 'cal-work');
    expect(work_reads.at(-1)?.delta_link).toBe('work-1');
    expect(retried.summary.errors).toEqual([]);
    const new_key = retried.snapshot?.entries.find((e) => e.event_id === 'e-work')?.storage_key;
    expect(new_key).toBeDefined();
    expect(new_key).not.toBe(previous_key);
  });

  it('leaves no link when the first read has a failing event, so the next run reads in full', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-new', WITH_FILE)]);
    h.script.attachments['e-new'] = [
      { id: 'a1', name: 'agenda.pdf', kind: 'file', is_inline: false, size: 3 },
    ];
    h.script.hooks = { attachment_content: () => new Error('storage timeout') };
    await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(h.cursors.saved.at(-1)?.delta_link_by_calendar['cal-work']).toBeUndefined();

    h.script.hooks = {};
    h.script.deltas['cal-work'] = delta_of('work-2', [calendar_event('e-new', WITH_FILE)]);
    await h.service.backup_calendar('tenant-1', MAILBOX);

    const work_reads = h.calls.delta.filter((c) => c.calendar_id === 'cal-work');
    expect(work_reads.at(-1)?.delta_link).toBeUndefined();
  });

  it('keeps a failing calendar entries and link while other calendars still advance', async () => {
    const h = backup_harness();
    h.script.deltas['cal-default'] = delta_of('link-default-1', [calendar_event('e-default')]);
    h.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
    await h.service.backup_calendar('tenant-1', MAILBOX);

    h.script.deltas['cal-default'] = delta_of('link-default-2', [calendar_event('e-new-default')]);
    h.script.hooks = {
      delta: (calendar_id) => (calendar_id === 'cal-work' ? new Error('boom') : undefined),
    };
    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.errors).toEqual(['Calendar Work failed: boom']);
    const work_ids = result.snapshot?.entries
      .filter((e) => e.calendar_id === 'cal-work')
      .map((e) => e.event_id);
    expect(work_ids).toEqual(['e-work']);
    const cursor = h.cursors.saved.at(-1)?.delta_link_by_calendar;
    expect(cursor?.['cal-work']).toBe('work-1');
    expect(cursor?.['cal-default']).toBe('link-default-2');
  });

  it.each([
    ['AuthError', () => new AuthError('denied')],
    ['MailboxNotLicensedError', () => new MailboxNotLicensedError('unlicensed')],
  ])('ends the run and saves nothing on %s', async (_name, make_error) => {
    const h = backup_harness();
    h.script.hooks = {
      delta: (calendar_id) => (calendar_id === 'cal-work' ? make_error() : undefined),
    };

    await expect(h.service.backup_calendar('tenant-1', MAILBOX)).rejects.toThrow();
    expect(h.manifests.saved).toEqual([]);
    expect(h.cursors.saved).toEqual([]);
  });
});
