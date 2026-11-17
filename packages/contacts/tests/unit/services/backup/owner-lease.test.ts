import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import { OwnerBusyError, OwnerLeaseLostError } from '@wisecom/atlas-types';
import {
  contact,
  fake_connector,
  memory_cursors,
  memory_manifests,
  tenant_factory_for,
} from '@wisecom/atlas-types/testing/stub-contacts-ports';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

import { ContactsBackupService } from '@/services/backup/backup.service';

/**
 * Issue #623: two contacts backups of one mailbox overwrote each other's delta cursor with no
 * error. The backup now runs under the mailbox's contacts lease.
 */
const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const LEASE = { workload: 'contacts', owner_id: MAILBOX, operation: 'backup' } as const;

function harness() {
  const { connector, script, delta_calls } = fake_connector();
  script.deltas = {
    'f-default': { upserted: [contact('c1')], removed_ids: [], delta_link: 'd-1', reset: false },
    'f-sub': { upserted: [], removed_ids: [], delta_link: 's-1', reset: false },
  };
  const manifests = memory_manifests();
  const cursors = memory_cursors();
  const cursor_loads: string[] = [];
  const leases = stub_owner_leases();
  const { ctx, objects } = stub_tenant_context();
  const service = new ContactsBackupService(
    tenant_factory_for(ctx),
    connector,
    manifests,
    {
      ...cursors,
      load: async (load_ctx, mailbox) => {
        // Reading the cursor is only safe once the lease is held.
        cursor_loads.push(leases.events.join(','));
        return cursors.load(load_ctx, mailbox);
      },
    },
    leases.leases,
  );
  return { service, connector, delta_calls, manifests, cursors, cursor_loads, leases, objects };
}

describe('contacts backup under the mailbox lease (issue #623)', () => {
  it('takes the lease before it reads the cursor and releases it after the run', async () => {
    const h = harness();

    const result = await h.service.backup_contacts('tenant-1', MAILBOX.toUpperCase(), {});

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

    await expect(h.service.backup_contacts('tenant-1', MAILBOX, {})).rejects.toBeInstanceOf(
      OwnerBusyError,
    );

    expect(h.cursor_loads).toEqual([]);
    expect(h.delta_calls).toEqual([]);
    expect(h.manifests.saved).toEqual([]);
    expect(h.cursors.saved).toEqual([]);
    expect(Object.keys(h.objects)).toEqual([]);
  });

  it('writes neither manifest nor cursor once the lease is lost mid-run', async () => {
    const h = harness();
    h.leases.fail_checks_with(new OwnerLeaseLostError(LEASE, 'another operation replaced it'));

    await expect(h.service.backup_contacts('tenant-1', MAILBOX, {})).rejects.toBeInstanceOf(
      OwnerLeaseLostError,
    );

    // The folders were read, so the run got as far as its first commit point.
    expect(h.delta_calls).toHaveLength(2);
    expect(h.manifests.saved).toEqual([]);
    expect(h.cursors.saved).toEqual([]);
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run fails', async () => {
    const h = harness();
    h.connector.list_contact_folders = async () => {
      throw new Error('graph unavailable');
    };

    await expect(h.service.backup_contacts('tenant-1', MAILBOX, {})).rejects.toThrow(
      'graph unavailable',
    );

    expect(h.leases.events.at(-1)).toBe('release');
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run is interrupted', async () => {
    const h = harness();

    const result = await h.service.backup_contacts('tenant-1', MAILBOX, {
      should_interrupt: () => true,
    });

    expect(result.interrupted).toBe(true);
    expect(h.cursors.saved).toEqual([]);
    expect(h.leases.held()).toBe(0);
  });

  it('releases the lease when the run is cancelled inside a Graph call', async () => {
    const h = harness();
    const abort = new AbortController();
    h.connector.list_contact_folders = async () => {
      abort.abort();
      throw abort.signal.reason;
    };

    const result = await h.service.backup_contacts('tenant-1', MAILBOX, {
      abort_signal: abort.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(h.leases.events).toEqual(['acquire', 'release']);
  });
});
