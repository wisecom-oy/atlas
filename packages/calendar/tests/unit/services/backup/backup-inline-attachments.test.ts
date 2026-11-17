import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';

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

/** Graph reports `hasAttachments: false` for an event whose only attachment is inline. */
const HTML_BODY_WITH_IMAGE = {
  body: { contentType: 'html', content: '<p><img src="cid:img1"></p>' },
};

const INLINE_IMAGE = {
  id: 'a1',
  name: 'photo.png',
  kind: 'file',
  content_type: 'image/png',
  is_inline: true,
  content_id: 'img1',
  size: 3,
} as const;

describe('CalendarBackupService inline attachments', () => {
  it('lists and stores an inline-only event that Graph reports without attachments', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-inline', HTML_BODY_WITH_IMAGE),
    ]);
    h.script.attachments['e-inline'] = [INLINE_IMAGE];
    h.script.attachment_bytes['a1'] = Buffer.from('PNG');

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.attachments_skipped).toBe(0);
    expect(result.summary.healthy).toBe(true);
    const stored = result.snapshot?.entries.find((e) => e.event_id === 'e-inline');
    expect(stored?.attachments).toEqual([
      expect.objectContaining({ attachment_id: 'a1', content_id: 'img1', is_inline: true }),
    ]);
  });

  it('counts a cid: reference with no listed attachment and reports the run unhealthy', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-dangling', HTML_BODY_WITH_IMAGE),
    ]);
    h.script.attachments['e-dangling'] = [];

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.attachments_skipped).toBe(1);
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.warnings).toEqual([
      'Event "Event e-dangling" (e-dangling) in Work: inline image referenced by the body is not captured',
    ]);
  });

  it('does not list attachments for an event whose body has no cid: reference', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-plain', { body: { contentType: 'html', content: '<p>Hi</p>' } }),
    ]);
    h.script.attachments['e-plain'] = [INLINE_IMAGE];

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.healthy).toBe(true);
    expect(result.snapshot?.entries.find((e) => e.event_id === 'e-plain')?.attachments).toBe(
      undefined,
    );
  });

  it('ignores a cid: string in a plain-text body', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-text', { body: { contentType: 'text', content: 'see cid:img1' } }),
    ]);
    h.script.attachments['e-text'] = [INLINE_IMAGE];

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.healthy).toBe(true);
    expect(result.snapshot?.entries.find((e) => e.event_id === 'e-text')?.attachments).toBe(
      undefined,
    );
  });

  it('fails the event when an inline image cannot be fetched, so the run is not healthy', async () => {
    const h = backup_harness();
    h.script.deltas['cal-work'] = delta_of('work-1', [
      calendar_event('e-inline', HTML_BODY_WITH_IMAGE),
    ]);
    h.script.attachments['e-inline'] = [INLINE_IMAGE];
    h.script.hooks = { attachment_content: () => new Error('storage timeout') };

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.errors).toEqual([
      'Event "Event e-inline" (e-inline) in Work failed: storage timeout',
    ]);
    expect(result.summary.healthy).toBe(false);
  });
});
