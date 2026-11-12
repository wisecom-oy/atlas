import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { OwnerBusyError, OwnerLeaseLostError } from '@wisecom/atlas-types';
import { calendar_event, delta_of } from '@wisecom/atlas-types/testing/stub-calendar-ports';
import { calendar_rig } from '@wisecom/atlas-types/testing/stub-calendar-rig';
import { MAILBOX } from '@wisecom/atlas-types/testing/stub-calendar-snapshots';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { CalendarBackupService } from '@/services/backup/backup.service';

/**
 * Issue #623: two calendar backups of one mailbox overwrote each other's delta cursor with no
 * error. The backup now runs under the mailbox's calendar lease.
 */
const LEASE = { workload: 'calendar', owner_id: MAILBOX, operation: 'backup' } as const;

function harness() {
  const leases = stub_owner_leases();
  const cursor_loads: string[] = [];
  const rig = calendar_rig(
    (s) =>
      new CalendarBackupService(
        s.tenant_factory,
        s.connector,
        s.manifests,
        {
          ...s.cursors,
          load: async (ctx, mailbox) => {
            // Reading the cursor is only safe once the lease is held.
            cursor_loads.push(leases.events.join(','));
            return s.cursors.load(ctx, mailbox);
          },
        },
        leases.leases,
      ),
  );
  rig.script.deltas['cal-work'] = delta_of('work-1', [calendar_event('e-work')]);
  return { ...rig, leases, cursor_loads };
}

describe('calendar backup under the mailbox lease (issue #623)', () => {
  it('takes the lease before it reads the cursor and releases it after the run', async () => {
    const h = harness();

    const result = await h.service.backup_calendar('tenant-1', MAILBOX.toUpperCase());

    expect(result.summary.snapshot_created).toBe(true);
    expect(h.leases.requests).toEqual([LEASE]);
    expect(h.cursor_loads).toEqual(['acquire']);
    // One check before the manifest and one before the cursor, then the release.
    expect(h.leases.events).toEqual(['acquire', 'assert', 'assert', 'release']);
    expect(h.leases.held()).toBe(0);
  });

  it('fails before reading the cursor and writes nothing while another run holds the mailbox', async () => {
    const h = harness();
    h.leases.refuse_with(new OwnerBusyError({ ...LEASE, held_by_operation: 'backup' }));

    await expect(h.service.backup_calendar('tenant-1', MAILBOX)).rejects.toBeInstanceOf(
      OwnerBusyError,
    );

    expect(h.cursor_loads).toEqual([]);
    expect(h.calls.delta).toEqual([]);
    expect(h.manifests.saved).toEqual([]);
    expect(h.cursors.saved).toEqual([]);
    expect(Object.keys(h.objects)).toEqual([]);
  });

  it('writes neither manifest nor cursor once the lease is lost mid-run', async () => {
    const h = harness();
    h.leases.fail_checks_with(new OwnerLeaseLostError(LEASE, 'another operation replaced it'));

    await expect(h.service.backup_calendar('tenant-1', MAILBOX)).rejects.toBeInstanceOf(
      OwnerLeaseLostError,
    );

    // The calendars were read, so the run got as far as its first commit point.
    expect(h.calls.delta).toHaveLength(2);
    expect(h.manifests.saved).toEqual([]);
    expect(h.cursors.saved).toEqual([]);
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run fails', async () => {
    const h = harness();
    h.connector.list_calendars = async () => {
      throw new Error('graph unavailable');
    };

    await expect(h.service.backup_calendar('tenant-1', MAILBOX)).rejects.toThrow(
      'graph unavailable',
    );

    expect(h.leases.events.at(-1)).toBe('release');
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run is interrupted', async () => {
    const h = harness();

    const result = await h.service.backup_calendar('tenant-1', MAILBOX, {
      should_interrupt: () => true,
    });

    expect(result.interrupted).toBe(true);
    expect(h.cursors.saved).toEqual([]);
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run is cancelled inside a Graph call', async () => {
    const h = harness();
    const abort = new AbortController();
    h.connector.list_calendars = async () => {
      abort.abort();
      throw abort.signal.reason;
    };

    const result = await h.service.backup_calendar('tenant-1', MAILBOX, {
      abort_signal: abort.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(h.leases.events).toEqual(['acquire', 'release']);
  });
});
