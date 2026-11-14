import { describe, expect, it } from 'vitest';
import type { ManifestRepository, TenantContextFactory } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { DeletionService } from '@/services/deletion/deletion.service';
import { TENANT_LEASE_KEY } from '@/services/lease/owner-lease-key';
import {
  lease_harness,
  MINUTE_MS,
  OUTLOOK_BACKUP,
  OUTLOOK_KEY,
  START_MS,
  type LeaseHarness,
} from '../lease/owner-lease-harness';

const TENANT = 'tenant-test';
const DEK = '_meta/dek.enc';
const DATA = 'data/owner-1/aaa';

/**
 * A purge over an in-memory bucket with the real lease adapter, so the lease and the sweep share
 * one storage (issue #739). `wrap_storage` injects the faults and the competing writes.
 */
function purge_rig(wrap_storage: Parameters<typeof lease_harness>[0] = () => ({})): {
  h: LeaseHarness;
  service: DeletionService;
} {
  // No version listing: the sweep then falls back to plain keys, as on a backend without versions.
  const h = lease_harness((inner) => ({
    list_versions: async () => [],
    ...wrap_storage(inner),
  }));
  const factory = {
    create_storage_only: async () => h.ctx,
    create_readonly: async () => h.ctx,
    create: async () => h.ctx,
  } as unknown as TenantContextFactory;
  const service = new DeletionService(factory, {} as ManifestRepository, h.leases);
  h.bucket.set_raw(DATA, Buffer.from('ciphertext'));
  h.bucket.set_raw(DEK, Buffer.from('wrapped-dek'));
  return { h, service };
}

describe('purge under the tenant lease', () => {
  it('is refused while an owner lease is live, and deletes nothing', async () => {
    const { h, service } = purge_rig();
    h.store({ operation: 'backup' }, OUTLOOK_KEY);

    const err = await service.purge_tenant(TENANT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OwnerBusyError);
    expect(err).toMatchObject({ workload: 'outlook', held_by_operation: 'backup' });
    expect(h.bucket.keys()).toEqual([DATA, DEK, OUTLOOK_KEY].sort());
  });

  it('erases the whole bucket past a stale owner lease, and leaves no lease object', async () => {
    const { h, service } = purge_rig();
    h.store({ expires_at: new Date(START_MS - MINUTE_MS).toISOString() }, OUTLOOK_KEY);

    const result = await service.purge_tenant(TENANT);

    // The data object, the stale owner lease the sweep reaches like any object, and the DEK.
    expect(result.deleted_objects).toBe(3);
    expect(h.bucket.keys()).toEqual([]);
  });

  it('deletes the data, then the DEK, then the tenant lease', async () => {
    const deleted: string[] = [];
    const { service, h } = purge_rig((inner) => ({
      delete: async (key: string) => {
        deleted.push(key);
        return inner.delete(key);
      },
    }));

    await service.purge_tenant(TENANT);

    expect(deleted).toEqual([DATA, DEK, TENANT_LEASE_KEY]);
    expect(h.bucket.keys()).toEqual([]);
  });

  it('holds the lease during the sweep: an owner backup started mid-sweep is refused', async () => {
    let owner_attempt: unknown;
    let attempted = false;
    const { service, h } = purge_rig((inner) => ({
      delete: async (key: string) => {
        if (!attempted && key === DATA) {
          attempted = true;
          owner_attempt = await h.leases.acquire(h.ctx, OUTLOOK_BACKUP).catch((e: unknown) => e);
        }
        return inner.delete(key);
      },
    }));

    await service.purge_tenant(TENANT);

    expect(owner_attempt).toBeInstanceOf(OwnerBusyError);
    expect(owner_attempt).toMatchObject({ held_by_operation: 'purge' });
  });

  it('releases the tenant lease when the sweep itself fails', async () => {
    const { service, h } = purge_rig((inner) => ({
      list: async (prefix: string, limit?: number) => {
        if (prefix === '') throw new Error('listing failed');
        return inner.list(prefix, limit);
      },
    }));

    await expect(service.purge_tenant(TENANT)).rejects.toThrow('listing failed');

    expect(h.stored(TENANT_LEASE_KEY)).toBeUndefined();
    expect(h.bucket.keys()).toContain(DEK);
  });

  it('a purge killed midway leaves a lease that expires and stops blocking owners', async () => {
    const { h } = purge_rig();
    // Stands in for a purge that was killed after its first write: the lease stays behind.
    await h.leases.acquire(h.ctx, {
      workload: 'tenant',
      owner_id: TENANT,
      operation: 'purge',
    });

    h.advance(6 * MINUTE_MS);
    const backup = await h.leases.acquire(h.ctx, OUTLOOK_BACKUP);

    expect(h.stored(OUTLOOK_KEY)?.holder_id).toBe('holder-2');
    await backup.release();
  });
});
