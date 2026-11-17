/**
 * Issue #623: a deletion and a backup of one owner must not interleave. These run the OneDrive
 * deletion against the real lease over an in-memory bucket, so the lease object itself is part of
 * what is checked: taken first, erased last, and never left behind.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { OneDriveManifestRepository, TenantContextFactory } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';

const OWNER = '00000000-0000-0000-0000-00000000abcd';
const LEASE_KEY = `onedrive/_meta/${OWNER}/lease.json`;
const OWNER_KEYS = [
  `onedrive/manifests/${OWNER}/od-snap-1-abc.json`,
  `onedrive/data/${OWNER}/aaa`,
  `onedrive/_meta/${OWNER}/delta.json`,
];
const OTHER_KEY = 'onedrive/_meta/someone-else/delta.json';

function setup() {
  const harness = in_memory_tenant_context();
  for (const key of [...OWNER_KEYS, OTHER_KEY]) harness.set_raw(key, Buffer.from('x'));
  // An unversioned bucket: no object versions, so every key is removed by a plain delete.
  harness.ctx.storage.list_versions = async () => [];
  harness.ctx.storage.abort_incomplete_uploads = async () => 0;
  const deleted: string[] = [];
  const remove = harness.ctx.storage.delete.bind(harness.ctx.storage);
  harness.ctx.storage.delete = async (key) => {
    deleted.push(key);
    await remove(key);
  };
  const factory = {
    create: vi.fn(),
    create_storage_only: async () => harness.ctx,
  } as unknown as TenantContextFactory;
  const leases = new StorageOwnerLeases();
  const service = new OneDriveDeletionService(factory, {} as OneDriveManifestRepository, leases);
  return { harness, leases, service, deleted };
}

describe('owner erasure under the owner lease (issue #623)', () => {
  it('erases the owner and leaves no lease behind', async () => {
    const { harness, service } = setup();

    const result = await service.delete_owner_data('t', OWNER);

    expect(harness.keys()).toEqual([OTHER_KEY]);
    // The lease is not backup data, so it is not part of what the erasure reports.
    expect(result.deleted_manifests + result.deleted_objects).toBe(OWNER_KEYS.length);
  });

  it('removes the lease after everything else, although the owner _meta prefix contains it', async () => {
    const { service, deleted } = setup();

    await service.delete_owner_data('t', OWNER);

    expect(deleted.at(-1)).toBe(LEASE_KEY);
    expect(deleted.filter((key) => key === LEASE_KEY)).toHaveLength(1);
    expect(deleted.slice(0, -1).sort()).toEqual([...OWNER_KEYS].sort());
  });

  it('is refused while a backup holds the owner, and deletes nothing', async () => {
    const { harness, leases, service, deleted } = setup();
    const backup = await leases.acquire(harness.ctx, {
      workload: 'onedrive',
      owner_id: OWNER,
      operation: 'backup',
    });

    const error = await service.delete_owner_data('t', OWNER).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
    expect(error).toMatchObject({ held_by_operation: 'backup', owner_id: OWNER });
    expect(deleted).toEqual([]);
    expect(harness.keys()).toEqual([LEASE_KEY, OTHER_KEY, ...OWNER_KEYS].sort());
    await backup.release();
  });

  it('runs once the backup has released the owner', async () => {
    const { harness, leases, service } = setup();
    const backup = await leases.acquire(harness.ctx, {
      workload: 'onedrive',
      owner_id: OWNER,
      operation: 'backup',
    });
    await backup.release();

    await service.delete_owner_data('t', OWNER);

    expect(harness.keys()).toEqual([OTHER_KEY]);
  });

  it('does not block the deletion of another owner', async () => {
    const { harness, leases, service } = setup();
    const backup = await leases.acquire(harness.ctx, {
      workload: 'onedrive',
      owner_id: 'someone-else',
      operation: 'backup',
    });

    await service.delete_owner_data('t', OWNER);

    expect(harness.keys()).toEqual([OTHER_KEY, 'onedrive/_meta/someone-else/lease.json'].sort());
    await backup.release();
  });
});
