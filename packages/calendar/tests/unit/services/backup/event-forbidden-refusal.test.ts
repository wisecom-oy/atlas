import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { AuthError } from '@wisecom/atlas-types';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { CALENDARS_READ, graph_call } from '@/adapters/graph-calendar-requests';
import { CalendarBackupService } from '@/services/backup/backup.service';

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

/** What the calendar adapter rejects with when Graph answers 403 with `code`. */
async function calendar_403(code: string): Promise<unknown> {
  return graph_call(CALENDARS_READ, () => Promise.reject(graph_error(403, code, 'Refused'))).catch(
    (err: unknown) => err,
  );
}

/** A harness whose `e-file` attachment download is answered with `refusal`. */
function refused_attachment(refusal: unknown) {
  const h = backup_harness();
  h.script.deltas['cal-work'] = delta_of('work-1', [
    calendar_event('e-plain'),
    calendar_event('e-file', { hasAttachments: true }),
  ]);
  h.script.attachments['e-file'] = [
    { id: 'a1', name: 'file.bin', kind: 'file', is_inline: false, size: 3 },
  ];
  h.script.hooks = { attachment_content: () => refusal as Error };
  return h;
}

// Issue #865: only a 403 whose code means a missing grant ends the mailbox run.
describe('a 403 on one event attachment', () => {
  it('fails that event alone when its code is not a missing grant', async () => {
    const h = refused_attachment(await calendar_403('UnknownError'));

    const result = await h.service.backup_calendar('tenant-1', MAILBOX);

    expect(result.summary.errors).toEqual([
      expect.stringContaining('403 UnknownError, which does not name a missing permission'),
    ]);
    expect(result.summary.healthy).toBe(false);
    expect(result.snapshot?.entries.map((e) => e.event_id)).toContain('e-plain');
  });

  it('ends the run and saves nothing when its code means a missing grant', async () => {
    const h = refused_attachment(await calendar_403('ErrorAccessDenied'));

    await expect(h.service.backup_calendar('tenant-1', MAILBOX)).rejects.toThrow(AuthError);
    expect(h.manifests.saved).toEqual([]);
  });
});
