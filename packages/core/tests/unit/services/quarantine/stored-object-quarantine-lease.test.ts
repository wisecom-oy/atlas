/**
 * Issue #623: a quarantine removes a manifest a backup of the same owner may be reading as its
 * head, so it takes that owner's lease and is refused while the backup runs.
 */
import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import { OwnerBusyError, OwnerLeaseLostError, UnreadableContentError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@/services/quarantine/stored-object-quarantine';

const ONEDRIVE_KEY = 'onedrive/manifests/owner-1/od-snap-1000-abc.json';
const OUTLOOK_KEY = 'manifests/owner-9/snap-1.json';

/** A target that accepts any key and reports whatever is stored there as damaged. */
function damaged_target(lease_workload: QuarantineTarget['lease_workload']): QuarantineTarget {
  return {
    workload: 'Test',
    lease_workload,
    accepts: 'test manifests',
    kind_of: () => 'manifest',
    read: async () => {
      throw new UnreadableContentError('The manifest does not decrypt');
    },
  };
}

function factory_for(ctx: TenantContext): TenantContextFactory {
  return { create: async () => ctx } as unknown as TenantContextFactory;
}

function bucket_with(key: string) {
  const harness = in_memory_tenant_context();
  harness.set_raw(key, Buffer.from('damaged'));
  return harness;
}

describe('quarantine under the owner lease (issue #623)', () => {
  it.each([
    ['onedrive', ONEDRIVE_KEY, 'owner-1'],
    ['outlook', OUTLOOK_KEY, 'owner-9'],
  ] as const)('takes the %s lease of the owner the key names', async (workload, key, owner_id) => {
    const harness = bucket_with(key);
    const leases = stub_owner_leases();

    await quarantine_unreadable_object(
      factory_for(harness.ctx),
      leases.leases,
      damaged_target(workload),
      't',
      key,
    );

    expect(leases.requests).toEqual([{ workload, owner_id, operation: 'quarantine' }]);
    expect(leases.events).toEqual(['acquire', 'assert', 'release']);
    expect(harness.keys()).toEqual([`_quarantine/${key}`]);
  });

  it('is refused while a backup holds the owner, and moves nothing', async () => {
    const harness = bucket_with(ONEDRIVE_KEY);
    const leases = new StorageOwnerLeases();
    const backup = await leases.acquire(harness.ctx, {
      workload: 'onedrive',
      owner_id: 'owner-1',
      operation: 'backup',
    });

    const move = quarantine_unreadable_object(
      factory_for(harness.ctx),
      leases,
      damaged_target('onedrive'),
      't',
      ONEDRIVE_KEY,
    );

    await expect(move).rejects.toBeInstanceOf(OwnerBusyError);
    await expect(move).rejects.toMatchObject({ held_by_operation: 'backup' });
    expect(harness.keys()).toEqual([ONEDRIVE_KEY, 'onedrive/_meta/owner-1/lease.json'].sort());
    expect(harness.destroyed()).toBe(1);
    await backup.release();
  });

  it('moves nothing when the lease was lost before the move, and still releases', async () => {
    const harness = bucket_with(ONEDRIVE_KEY);
    const leases = stub_owner_leases();
    leases.fail_checks_with(
      new OwnerLeaseLostError({ workload: 'onedrive', owner_id: 'owner-1' }, 'taken over'),
    );

    const move = quarantine_unreadable_object(
      factory_for(harness.ctx),
      leases.leases,
      damaged_target('onedrive'),
      't',
      ONEDRIVE_KEY,
    );

    await expect(move).rejects.toBeInstanceOf(OwnerLeaseLostError);
    expect(harness.keys()).toEqual([ONEDRIVE_KEY]);
    expect(leases.held()).toBe(0);
  });

  it('releases the owner after a quarantine, so a backup can start', async () => {
    const harness = bucket_with(ONEDRIVE_KEY);
    const leases = new StorageOwnerLeases();

    await quarantine_unreadable_object(
      factory_for(harness.ctx),
      leases,
      damaged_target('onedrive'),
      't',
      ONEDRIVE_KEY,
    );

    expect(harness.keys()).toEqual([`_quarantine/${ONEDRIVE_KEY}`]);
  });
});
