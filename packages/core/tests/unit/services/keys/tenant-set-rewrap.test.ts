import { describe, expect, it } from 'vitest';
import type { TenantSetRewrapRequest } from '@wisecom/atlas-types';
import { ConfigError } from '@wisecom/atlas-types';
import { TenantSetRewrapService } from '@/services/keys/tenant-set-rewrap.service';
import {
  DEK_KEY,
  NEW_PASSPHRASE,
  OLD_PASSPHRASE,
  OTHER_PASSPHRASE,
  key_set_rig,
  type KeySetRig,
} from './key-set-rig';

/**
 * Issue #716. The passphrase is shared by every tenant profile, and `keys rewrap` re-wrapped one
 * tenant. These cover the classification each tenant gets and a rerun after a partial run.
 */

function rotation(tenant_ids: string[]): TenantSetRewrapRequest {
  return { tenant_ids, current_passphrase: OLD_PASSPHRASE, next_passphrase: NEW_PASSPHRASE };
}

function service_for(rig: KeySetRig): TenantSetRewrapService {
  return new TenantSetRewrapService(rig.factory, rig.leases);
}

describe('rewrap_tenant_set classification', () => {
  it('re-wraps every tenant under the old passphrase to the same data key', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE, b: OLD_PASSPHRASE });

    const report = await service_for(rig).rewrap_tenant_set(rotation(['a', 'b']));

    expect(report.outcomes.map((o) => [o.tenant_id, o.status])).toEqual([
      ['a', 'rewrapped'],
      ['b', 'rewrapped'],
    ]);
    expect(report).toMatchObject({ complete: true, passphrase_changed: true });
    for (const tenant_id of ['a', 'b']) {
      expect(await rig.opens_with(tenant_id, OLD_PASSPHRASE)).toBeUndefined();
      expect(await rig.opens_with(tenant_id, NEW_PASSPHRASE)).toEqual(
        rig.tenants.get(tenant_id)!.dek,
      );
    }
  });

  it('leaves a tenant that already opens with the new passphrase untouched', async () => {
    const rig = await key_set_rig({ a: NEW_PASSPHRASE });

    const report = await service_for(rig).rewrap_tenant_set(rotation(['a']));

    expect(report.outcomes).toEqual([{ tenant_id: 'a', status: 'already_rewrapped' }]);
    expect(report.complete).toBe(true);
    expect(rig.tenants.get('a')!.bucket.versions(DEK_KEY)).toHaveLength(1);
  });

  it('reports a bucket without a key, and a tenant without a bucket, as no_key', async () => {
    const rig = await key_set_rig({ empty: null });

    const report = await service_for(rig).rewrap_tenant_set(rotation(['empty', 'missing']));

    expect(report.outcomes).toEqual([
      { tenant_id: 'empty', status: 'no_key' },
      { tenant_id: 'missing', status: 'no_key' },
    ]);
    expect(report.complete).toBe(true);
  });

  it('reports a key neither passphrase opens, writes nothing, and is not complete', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE, foreign: OTHER_PASSPHRASE });

    const report = await service_for(rig).rewrap_tenant_set(rotation(['foreign', 'a']));

    expect(report.outcomes.map((o) => o.status)).toEqual(['unopenable', 'rewrapped']);
    expect(report.complete).toBe(false);
    expect(rig.tenants.get('foreign')!.bucket.versions(DEK_KEY)).toHaveLength(1);
  });

  it('reports a write failure for that tenant and carries on with the next', async () => {
    const rig = await key_set_rig({ broken: OLD_PASSPHRASE, b: OLD_PASSPHRASE });
    const broken = rig.tenants.get('broken')!.bucket.storage;
    const put = broken.put.bind(broken);
    broken.put = async (key, ...rest) => {
      if (key === DEK_KEY) throw new Error('InternalError: backend unavailable');
      return put(key, ...rest);
    };

    const report = await service_for(rig).rewrap_tenant_set(rotation(['broken', 'b']));

    expect(report.outcomes[0]).toMatchObject({ tenant_id: 'broken', status: 'failed' });
    expect(report.outcomes[0]).toHaveProperty('detail', 'InternalError: backend unavailable');
    expect(report.outcomes[1]).toMatchObject({ tenant_id: 'b', status: 'rewrapped' });
    expect(report.complete).toBe(false);
  });

  it('re-wraps a tenant once even when two profiles name it', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE });

    const report = await service_for(rig).rewrap_tenant_set(rotation(['a', 'a']));

    expect(report.outcomes).toHaveLength(1);
    expect(rig.tenants.get('a')!.bucket.versions(DEK_KEY)).toHaveLength(2);
  });

  it('re-wraps every key that opens on a KDF-only refresh, and never reports already', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE });
    const refresh = {
      tenant_ids: ['a'],
      current_passphrase: OLD_PASSPHRASE,
      next_passphrase: OLD_PASSPHRASE,
    };

    const report = await service_for(rig).rewrap_tenant_set(refresh);

    expect(report.outcomes[0]).toMatchObject({ status: 'rewrapped' });
    expect(report.passphrase_changed).toBe(false);
  });

  it('refuses a new passphrase shorter than 14 bytes before touching any tenant', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE });
    const request = { ...rotation(['a']), next_passphrase: 'short' };

    await expect(service_for(rig).rewrap_tenant_set(request)).rejects.toBeInstanceOf(ConfigError);
    expect(rig.tenants.get('a')!.bucket.versions(DEK_KEY)).toHaveLength(1);
  });
});

describe('rewrap_tenant_set rerun after a partial run', () => {
  it('re-wraps only what the first run left, and then reports complete', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE, b: OLD_PASSPHRASE });
    const b_storage = rig.tenants.get('b')!.bucket.storage;
    const put = b_storage.put.bind(b_storage);
    let fail_b = true;
    b_storage.put = async (key, ...rest) => {
      if (key === DEK_KEY && fail_b) throw new Error('SlowDown');
      return put(key, ...rest);
    };

    const first = await service_for(rig).rewrap_tenant_set(rotation(['a', 'b']));
    expect(first.outcomes.map((o) => o.status)).toEqual(['rewrapped', 'failed']);
    expect(first.complete).toBe(false);

    fail_b = false;
    const second = await service_for(rig).rewrap_tenant_set(rotation(['a', 'b']));

    expect(second.outcomes.map((o) => o.status)).toEqual(['already_rewrapped', 'rewrapped']);
    expect(second.complete).toBe(true);
    // The first tenant was not written twice: one seed version and one re-wrap.
    expect(rig.tenants.get('a')!.bucket.versions(DEK_KEY)).toHaveLength(2);
  });

  it('finishes from the old passphrase after the configured one already changed', async () => {
    const rig = await key_set_rig({ a: NEW_PASSPHRASE, b: OLD_PASSPHRASE });
    // `--old-passphrase` alone: current is the typed old one, next the configured new one.
    const request = rotation(['a', 'b']);

    const report = await service_for(rig).rewrap_tenant_set(request);

    expect(report.outcomes.map((o) => o.status)).toEqual(['already_rewrapped', 'rewrapped']);
    expect(await rig.opens_with('b', NEW_PASSPHRASE)).toEqual(rig.tenants.get('b')!.dek);
  });
});
