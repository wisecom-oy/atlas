import { describe, expect, it } from 'vitest';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { TENANT_LEASE_KEY } from '@/services/lease/owner-lease-key';
import { DekRewrapService } from '@/services/keys/dek-rewrap.service';
import type { AtlasConfig } from '@/utils/config';
import {
  lease_harness,
  OUTLOOK_BACKUP,
  OUTLOOK_KEY,
  type LeaseHarness,
} from '../lease/owner-lease-harness';

/** Re-wrap under the tenant lease (issue #739). The tenant id is the in-memory bucket's. */
const TENANT = 'tenant-test';
const DEK_KEY = '_meta/dek.enc';
const OLD_PASSPHRASE = 'the-original-passphrase';
const NEW_PASSPHRASE = 'a-different-passphrase';

async function rewrap_rig(
  wrap_storage: Parameters<typeof lease_harness>[0] = () => ({}),
): Promise<{ h: LeaseHarness; service: DekRewrapService }> {
  const h = lease_harness(wrap_storage);
  const writer = new EnvelopeKeyService(OLD_PASSPHRASE);
  h.bucket.set_raw(DEK_KEY, await writer.wrap_dek(writer.generate_dek(), TENANT));
  const factory = {
    create_storage_only: async () => h.ctx,
  } as unknown as TenantContextFactory;
  const config = { tenant_id: TENANT, encryption_passphrase: OLD_PASSPHRASE } as AtlasConfig;
  return { h, service: new DekRewrapService(factory, config, h.leases) };
}

describe('re-wrapping the tenant key under the tenant lease', () => {
  it('is refused while an owner lease is live, and leaves the wrapper and no lease behind', async () => {
    const { h, service } = await rewrap_rig();
    h.store({ operation: 'backup' }, OUTLOOK_KEY);
    const wrapper_before = h.bucket.raw(DEK_KEY);

    const err = await service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OwnerBusyError);
    expect(err).toMatchObject({ workload: 'outlook', held_by_operation: 'backup' });
    expect(h.bucket.raw(DEK_KEY)).toEqual(wrapper_before);
    expect(h.stored(TENANT_LEASE_KEY)).toBeUndefined();
  });

  it('succeeds with no owner lease, and releases the tenant lease afterwards', async () => {
    const { h, service } = await rewrap_rig();

    const result = await service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE);

    expect(result.passphrase_changed).toBe(true);
    expect(h.stored(TENANT_LEASE_KEY)).toBeUndefined();
  });

  it('refuses an owner backup that starts while the wrapper is being written', async () => {
    let owner_attempt: unknown;
    let attempted = false;
    const rig = await rewrap_rig((inner) => ({
      put: async (key, data, metadata, policy, if_match, if_none_match) => {
        if (key === DEK_KEY && !attempted) {
          attempted = true;
          owner_attempt = await rig.h.leases
            .acquire(rig.h.ctx, OUTLOOK_BACKUP)
            .catch((e: unknown) => e);
        }
        return inner.put(key, data, metadata, policy, if_match, if_none_match);
      },
    }));

    await rig.service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE);

    expect(owner_attempt).toBeInstanceOf(OwnerBusyError);
    expect(owner_attempt).toMatchObject({ held_by_operation: 'rewrap' });
  });
});
