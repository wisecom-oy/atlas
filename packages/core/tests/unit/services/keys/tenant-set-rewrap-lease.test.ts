import { describe, expect, it } from 'vitest';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { TENANT_LEASE_KEY } from '@/services/lease/owner-lease-key';
import { TenantSetRewrapService } from '@/services/keys/tenant-set-rewrap.service';
import { DEK_KEY, NEW_PASSPHRASE, OLD_PASSPHRASE, key_set_rig } from './key-set-rig';

/** Each tenant is re-wrapped under its own tenant lease (issues #739 and #716). */

const BACKUP = { workload: 'outlook', owner_id: 'owner-1', operation: 'backup' } as const;
const ROTATION = {
  tenant_ids: ['busy', 'free'],
  current_passphrase: OLD_PASSPHRASE,
  next_passphrase: NEW_PASSPHRASE,
};

describe('rewrap_tenant_set and the tenant lease', () => {
  it('skips a tenant with a live owner lease, re-wraps the rest, and is not complete', async () => {
    const rig = await key_set_rig({ busy: OLD_PASSPHRASE, free: OLD_PASSPHRASE });
    const busy = rig.tenants.get('busy')!.bucket;
    const backup = await rig.leases.acquire({ tenant_id: 'busy', storage: busy.storage }, BACKUP);

    try {
      const report = await new TenantSetRewrapService(rig.factory, rig.leases).rewrap_tenant_set(
        ROTATION,
      );

      expect(report.outcomes[0]).toMatchObject({ tenant_id: 'busy', status: 'busy' });
      expect(report.outcomes[1]).toMatchObject({ tenant_id: 'free', status: 'rewrapped' });
      expect(report.complete).toBe(false);
      expect(busy.versions(DEK_KEY)).toHaveLength(1);
    } finally {
      await backup.release();
    }
  });

  it('releases every tenant lease it took', async () => {
    const rig = await key_set_rig({ busy: OLD_PASSPHRASE, free: OLD_PASSPHRASE });

    await new TenantSetRewrapService(rig.factory, rig.leases).rewrap_tenant_set(ROTATION);

    for (const tenant of rig.tenants.values()) {
      expect(await tenant.bucket.storage.exists(TENANT_LEASE_KEY)).toBe(false);
    }
  });

  it('refuses an owner backup that starts while a wrapper is being written', async () => {
    const rig = await key_set_rig({ busy: OLD_PASSPHRASE, free: OLD_PASSPHRASE });
    const storage: ObjectStorage = rig.tenants.get('free')!.bucket.storage;
    const put = storage.put.bind(storage);
    let owner_attempt: unknown;
    storage.put = async (key, ...rest) => {
      if (key === DEK_KEY && owner_attempt === undefined) {
        owner_attempt = await rig.leases
          .acquire({ tenant_id: 'free', storage }, BACKUP)
          .catch((err: unknown) => err);
      }
      return put(key, ...rest);
    };

    await new TenantSetRewrapService(rig.factory, rig.leases).rewrap_tenant_set(ROTATION);

    expect(owner_attempt).toBeInstanceOf(OwnerBusyError);
    expect(owner_attempt).toMatchObject({ held_by_operation: 'rewrap' });
  });
});
