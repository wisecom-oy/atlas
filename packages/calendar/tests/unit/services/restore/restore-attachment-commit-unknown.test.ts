/**
 * Issue #891. An event attachment whose final upload chunk ended ambiguously may be on the event,
 * so the restore reports its outcome as unknown instead of calling it "not restored".
 */
import 'reflect-metadata';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { UploadCommitUnknownError } from '@wisecom/atlas-types';
import { calendar_event } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import {
  MAILBOX,
  SNAPSHOT,
  TENANT,
  save_snapshot,
  stored_event,
  stored_file,
} from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { describe, expect, it } from 'vitest';
import { CalendarRestoreService } from '@/services/restore/restore.service';

describe('restore of an event attachment whose final chunk ended ambiguously', () => {
  it('reports the attachment as possibly present and leaves the run partial', async () => {
    const rig = calendar_rig(
      (s) =>
        new CalendarRestoreService(
          s.tenant_factory,
          s.connector,
          s.manifests,
          stub_owner_leases().leases,
        ),
    );
    const unknown = new UploadCommitUnknownError(
      { range: 'bytes 0-3670015/3670016', item: 'attachment' },
      'HTTP 504',
    );
    rig.script.hooks = { upload_attachment: () => unknown };
    const file = stored_file(rig.objects, 'att-1', 'agenda.pdf', 'PDF-BYTES');
    save_snapshot(rig.manifests, [
      stored_event(rig.objects, 'src-default', calendar_event('e-1'), [file]),
    ]);

    const result = await rig.service.restore_calendar(TENANT, MAILBOX, { snapshot_id: SNAPSHOT });

    expect(result.events_restored).toBe(1);
    expect(result.errors).toEqual([
      `Event "Event e-1" (e-1) restored, but attachment "agenda.pdf": ${unknown.message}`,
    ]);
  });
});
