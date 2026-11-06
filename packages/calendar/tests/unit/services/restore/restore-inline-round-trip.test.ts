import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX, TENANT } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';

import { CalendarBackupService } from '@/services/backup/backup.service';
import { CalendarRestoreService } from '@/services/restore/restore.service';

/** Backup and restore services over one set of in-memory stores. */
function round_trip_harness() {
  return calendar_rig((s) => ({
    backup: new CalendarBackupService(s.tenant_factory, s.connector, s.manifests, s.cursors),
    restore: new CalendarRestoreService(s.tenant_factory, s.connector, s.manifests),
  }));
}

describe('inline attachments through backup and restore', () => {
  it('keeps contentId and inline status from backup through to the restored upload', async () => {
    const h = round_trip_harness();
    h.script.deltas['cal-default'] = delta_of('d1', [
      calendar_event('e1', { subject: 'Newsletter', hasAttachments: true }),
    ]);
    h.script.attachments['e1'] = [
      {
        id: 'a1',
        name: 'logo.png',
        kind: 'file',
        content_type: 'image/png',
        is_inline: true,
        content_id: 'cid-logo',
        size: 3,
      },
    ];
    h.script.attachment_bytes['a1'] = Buffer.from('PNG');

    const backup = await h.service.backup.backup_calendar(TENANT, MAILBOX);
    expect(backup.snapshot).toBeDefined();
    const stored = backup.snapshot?.entries.find((e) => e.event_id === 'e1');
    expect(stored?.attachments?.[0]?.content_id).toBe('cid-logo');

    await h.service.restore.restore_calendar(TENANT, MAILBOX, {
      snapshot_id: backup.snapshot!.snapshot_id,
    });

    expect(h.calls.uploads).toHaveLength(1);
    const { attachment } = h.calls.uploads[0]!;
    expect(attachment).toMatchObject({
      name: 'logo.png',
      is_inline: true,
      content_id: 'cid-logo',
    });
    expect(Buffer.from(attachment.content).toString()).toBe('PNG');
  });
});
