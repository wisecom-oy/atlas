/**
 * Issue #739 review: the lease is erased only while the run still holds it, and a lease version
 * that survives its removal is reported. A successor may own the lease key by the time a run that
 * lost its lease reaches the erase step, so that erase must be skipped without failing the run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeldOwnerLease } from '@wisecom/atlas-types';
import { OwnerLeaseLostError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { DEK_KEY, sweep_tenant_bucket } from '@/services/deletion/shared/tenant-purge-sweep';
import {
  erase_lease_versions,
  erase_leased_owner_scopes,
} from '@/services/deletion/shared/leased-owner-deletion';
import { holds_lease } from '@/services/lease/holds-lease';
import { logger } from '@/utils/logger';

const TENANT_LEASE = 'tenant/_meta/lease.json';
const DATA = 'data/owner-1/aaa';
const OWNER_LEASE = 'onedrive/_meta/owner-1/lease.json';
const OWNER_DATA = 'onedrive/data/owner-1/aaa';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A lease whose checks start failing once `lose` is called, as when a held lease is lost. */
function lease_that_can_be_lost(storage_key: string): { lease: HeldOwnerLease; lose: () => void } {
  let lost = false;
  return {
    lease: {
      storage_key,
      assert_held: (): void => {
        if (lost) throw new OwnerLeaseLostError({ workload: 'tenant', owner_id: 't' }, 'lost');
      },
      release: async (): Promise<void> => undefined,
    },
    lose: () => {
      lost = true;
    },
  };
}

/** An unversioned in-memory bucket whose deletes can be observed and hooked. */
function bucket(keys: readonly string[]) {
  const harness = in_memory_tenant_context();
  for (const key of keys) harness.set_raw(key, Buffer.from('x'));
  harness.ctx.storage.list_versions = async () => [];
  const deleted: string[] = [];
  const remove = harness.ctx.storage.delete.bind(harness.ctx.storage);
  const hook = { after_delete: (_key: string): void => undefined };
  harness.ctx.storage.delete = async (key) => {
    deleted.push(key);
    await remove(key);
    hook.after_delete(key);
  };
  return { harness, deleted, hook };
}

describe('erasing the lease while it is still held (issue #739 review)', () => {
  it('reports whether the run still holds its lease', () => {
    const { lease, lose } = lease_that_can_be_lost(TENANT_LEASE);
    expect(holds_lease(lease)).toBe(true);
    lose();
    expect(holds_lease(lease)).toBe(false);
  });

  it('warns with the lease key and the survivor count when a lease version survives', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { harness } = bucket([TENANT_LEASE]);
    harness.ctx.storage.delete = async () => {
      throw new Error('access denied');
    };

    await erase_lease_versions(harness.ctx.storage, TENANT_LEASE);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(TENANT_LEASE);
    expect(warn.mock.calls[0]?.[0]).toContain('1 version(s)');
  });

  it('does not warn when the lease is removed cleanly', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { harness } = bucket([TENANT_LEASE]);

    await erase_lease_versions(harness.ctx.storage, TENANT_LEASE);

    expect(harness.keys()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a purge that loses its lease before the lease step returns its result and leaves the lease', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { lease, lose } = lease_that_can_be_lost(TENANT_LEASE);
    const { harness, deleted, hook } = bucket([DATA, DEK_KEY, TENANT_LEASE]);
    hook.after_delete = (key) => {
      if (key === DEK_KEY) lose();
    };

    const result = await sweep_tenant_bucket(harness.ctx.storage, lease);

    expect(deleted).toEqual([DATA, DEK_KEY]);
    expect(result.deleted_objects).toBe(2);
    expect(result.retained_objects + result.failed_objects).toBe(0);
    expect(harness.keys()).toEqual([TENANT_LEASE]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TENANT_LEASE));
  });

  it('a purge that still holds its lease erases the lease after the sweep', async () => {
    const { lease } = lease_that_can_be_lost(TENANT_LEASE);
    const { harness } = bucket([DATA, DEK_KEY, TENANT_LEASE]);

    await sweep_tenant_bucket(harness.ctx.storage, lease);

    expect(harness.keys()).toEqual([]);
  });

  it('an owner erasure that loses its lease before the lease step returns its result and leaves the lease', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { lease, lose } = lease_that_can_be_lost(OWNER_LEASE);
    const { harness, deleted, hook } = bucket([OWNER_DATA, OWNER_LEASE]);
    hook.after_delete = (key) => {
      if (key === OWNER_DATA) lose();
    };

    const result = await erase_leased_owner_scopes(harness.ctx.storage, lease, [
      'onedrive/data/owner-1/',
    ]);

    expect(deleted).toEqual([OWNER_DATA]);
    expect(result.deleted_objects).toBe(1);
    expect(harness.keys()).toEqual([OWNER_LEASE]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(OWNER_LEASE));
  });

  it('an owner erasure that still holds its lease erases the lease last', async () => {
    const { lease } = lease_that_can_be_lost(OWNER_LEASE);
    const { harness, deleted } = bucket([OWNER_DATA, OWNER_LEASE]);

    await erase_leased_owner_scopes(harness.ctx.storage, lease, ['onedrive/data/owner-1/']);

    expect(deleted).toEqual([OWNER_DATA, OWNER_LEASE]);
    expect(harness.keys()).toEqual([]);
  });
});
