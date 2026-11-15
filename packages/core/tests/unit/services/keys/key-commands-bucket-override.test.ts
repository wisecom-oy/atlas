import { describe, expect, it } from 'vitest';
import type { AtlasConfig } from '@/utils/config';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { ConfigError } from '@wisecom/atlas-types';
import { OldWrapperPurgeService } from '@/services/keys/old-wrapper-purge.service';
import { TenantSetRewrapService } from '@/services/keys/tenant-set-rewrap.service';
import {
  DEK_KEY,
  NEW_PASSPHRASE,
  OLD_PASSPHRASE,
  key_set_rig,
  type KeySetRig,
} from './key-set-rig';

/**
 * Issue #768. Under `ATLAS_S3_BUCKET` the bucket resolver refuses every tenant but the run's, so
 * `keys rewrap` and `keys purge-old-wrappers` over several tenants must report the refused ones
 * and never count them as settled.
 */

const REFUSAL = new ConfigError(
  'ATLAS_S3_BUCKET names bucket "a-copy" for tenant a only, so this run refuses to open tenant b.',
);

/** The rig's factory, refusing tenant `b` as the resolver does under an exclusive override. */
function refusing_b(rig: KeySetRig): TenantContextFactory {
  return {
    ...rig.factory,
    create_storage_only: async (tenant_id: string) => {
      if (tenant_id === 'b') throw REFUSAL;
      return rig.factory.create_storage_only(tenant_id);
    },
  };
}

describe('key commands under an exclusive bucket override (issue #768)', () => {
  it('re-wraps the run tenant and reports the refused tenant as failed, leaving it untouched', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE, b: OLD_PASSPHRASE });

    const report = await new TenantSetRewrapService(refusing_b(rig), rig.leases).rewrap_tenant_set({
      tenant_ids: ['a', 'b'],
      current_passphrase: OLD_PASSPHRASE,
      next_passphrase: NEW_PASSPHRASE,
    });

    expect(report.outcomes).toEqual([
      expect.objectContaining({ tenant_id: 'a', status: 'rewrapped' }),
      { tenant_id: 'b', status: 'failed', detail: REFUSAL.message },
    ]);
    expect(report.complete).toBe(false);
    expect(rig.tenants.get('b')!.bucket.versions(DEK_KEY)).toHaveLength(1);
  });

  it('reports the refused tenant as failed when purging old wrappers', async () => {
    const rig = await key_set_rig({ a: NEW_PASSPHRASE, b: NEW_PASSPHRASE });
    const config = { encryption_passphrase: NEW_PASSPHRASE } as AtlasConfig;

    const report = await new OldWrapperPurgeService(
      refusing_b(rig),
      config,
      rig.leases,
    ).purge_old_wrappers({ tenant_ids: ['a', 'b'], previous_passphrases: [] });

    expect(report.outcomes.find((o) => o.tenant_id === 'b')).toMatchObject({
      status: 'failed',
      detail: REFUSAL.message,
    });
    expect(report.complete).toBe(false);
  });
});
