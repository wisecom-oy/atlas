import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { ListingIncompleteError } from '@wisecom/atlas-types';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { CalendarBackupService } from '@/services/backup/backup.service';

/**
 * Issue #853: a calendar listing that ended early was taken as the whole mailbox, so the next
 * snapshot dropped the unlisted calendars' events and the cursor dropped their delta links.
 */
function harness() {
  const rig = calendar_rig(
    (s) =>
      new CalendarBackupService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        s.cursors,
        stub_owner_leases().leases,
      ),
  );
  rig.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
  return rig;
}

describe('calendar backup with a calendar listing that ends early (issue #853)', () => {
  it('fails the run and writes neither snapshot nor cursor, keeping every calendar as it was', async () => {
    const h = harness();
    await h.service.backup_calendar('tenant-1', MAILBOX);
    const [first_snapshot] = h.manifests.saved;
    const [first_cursor] = h.cursors.saved;
    h.connector.list_calendars = async () => {
      throw new ListingIncompleteError('calendars', 1, 2);
    };

    await expect(h.service.backup_calendar('tenant-1', MAILBOX)).rejects.toBeInstanceOf(
      ListingIncompleteError,
    );

    expect(h.manifests.saved).toEqual([first_snapshot]);
    expect(h.cursors.saved).toEqual([first_cursor]);
    expect(first_snapshot?.calendars.map((c) => c.calendar_id)).toEqual([
      'cal-default',
      'cal-work',
    ]);
  });
});
