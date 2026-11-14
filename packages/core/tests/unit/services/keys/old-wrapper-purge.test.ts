import { describe, expect, it } from 'vitest';
import type { TenantContextFactory, TenantStorageContext } from '@wisecom/atlas-types';
import { ObjectLockRetainedError } from '@wisecom/atlas-types';
import { in_memory_versioned_storage } from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { OldWrapperPurgeService } from '@/services/keys/old-wrapper-purge.service';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import type { AtlasConfig } from '@/utils/config';
import {
  DEK_KEY,
  NEW_PASSPHRASE,
  OLD_PASSPHRASE,
  OTHER_PASSPHRASE,
  key_set_rig,
  type KeySetRig,
} from './key-set-rig';

/**
 * Issue #716. A re-wrap keeps the previous `_meta/dek.enc` version on a versioned bucket, and that
 * version still opens with the passphrase being retired.
 */

function purge_service(rig: KeySetRig, configured = NEW_PASSPHRASE): OldWrapperPurgeService {
  const config = { encryption_passphrase: configured } as AtlasConfig;
  return new OldWrapperPurgeService(rig.factory, config, rig.leases);
}

/** A tenant wrapped under the old passphrase, then re-wrapped under the new one. */
async function rotated_rig(): Promise<KeySetRig> {
  const rig = await key_set_rig({ a: OLD_PASSPHRASE });
  await rig.rewrap_as('a', NEW_PASSPHRASE);
  return rig;
}

describe('purge_old_wrappers', () => {
  it('deletes a noncurrent version that holds the current data key, and keeps the current one', async () => {
    const rig = await rotated_rig();
    const bucket = rig.tenants.get('a')!.bucket;
    const current_id = bucket.versions(DEK_KEY)[1]!.version_id;

    const report = await purge_service(rig).purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [OLD_PASSPHRASE],
    });

    expect(report.outcomes[0]).toMatchObject({ status: 'purged' });
    expect(report.outcomes[0]!.versions).toEqual([{ version_id: 'v1', status: 'deleted' }]);
    expect(bucket.versions(DEK_KEY).map((v) => v.version_id)).toEqual([current_id]);
    expect(report.complete).toBe(true);
  });

  it('keeps an old version no supplied passphrase opens, until the old passphrase is given', async () => {
    const rig = await rotated_rig();

    const first = await purge_service(rig).purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [],
    });
    expect(first.outcomes[0]).toMatchObject({ status: 'versions_left' });
    expect(first.outcomes[0]!.versions).toEqual([{ version_id: 'v1', status: 'unverified' }]);
    expect(first.complete).toBe(false);

    const second = await purge_service(rig).purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [OLD_PASSPHRASE],
    });
    expect(second.outcomes[0]).toMatchObject({ status: 'purged' });
  });

  it('keeps an old version that holds a different data key', async () => {
    const rig = await rotated_rig();
    const bucket = rig.tenants.get('a')!.bucket;
    // A version of another key that the old passphrase opens, older than both wrappers.
    const other = new EnvelopeKeyService(OLD_PASSPHRASE);
    const foreign = await other.wrap_dek(other.generate_dek(), 'a');
    await bucket.storage.put(DEK_KEY, foreign);
    await rig.rewrap_as('a', NEW_PASSPHRASE);

    const report = await purge_service(rig).purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [OLD_PASSPHRASE],
    });

    const statuses = report.outcomes[0]!.versions.map((v) => [v.version_id, v.status]);
    expect(statuses).toEqual([
      ['v1', 'deleted'],
      ['v2', 'deleted'],
      ['v3', 'different_key'],
    ]);
    expect(bucket.versions(DEK_KEY).map((v) => v.version_id)).toEqual(['v3', 'v4']);
  });

  it('reports a version under Object Lock as retained and leaves it', async () => {
    const rig = await rotated_rig();
    const bucket = rig.tenants.get('a')!.bucket;
    bucket.lock('v1', new ObjectLockRetainedError(DEK_KEY));

    const report = await purge_service(rig).purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [OLD_PASSPHRASE],
    });

    expect(report.outcomes[0]).toMatchObject({ status: 'versions_left' });
    expect(report.outcomes[0]!.versions[0]).toMatchObject({ version_id: 'v1', status: 'retained' });
    expect(bucket.versions(DEK_KEY)).toHaveLength(2);
    expect(report.complete).toBe(false);
  });

  it('refuses a tenant whose current wrapper the configured passphrase does not open', async () => {
    const rig = await key_set_rig({ a: OLD_PASSPHRASE });
    await rig.rewrap_as('a', OTHER_PASSPHRASE);
    const bucket = rig.tenants.get('a')!.bucket;

    const report = await purge_service(rig).purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [OLD_PASSPHRASE],
    });

    expect(report.outcomes[0]).toMatchObject({ status: 'current_unopenable', versions: [] });
    expect(bucket.versions(DEK_KEY)).toHaveLength(2);
  });

  it('reports tenants with no bucket or no key as nothing to purge', async () => {
    const rig = await key_set_rig({ empty: null });

    const report = await purge_service(rig).purge_old_wrappers({
      tenant_ids: ['empty', 'missing'],
      previous_passphrases: [],
    });

    expect(report.outcomes.map((o) => o.status)).toEqual(['no_key', 'no_key']);
    expect(report.complete).toBe(true);
  });
});

describe('purge_old_wrappers on storage that cannot prove a version is old', () => {
  /** One tenant over storage built with the given limitation, re-wrapped once. */
  async function limited_rig(options: Parameters<typeof in_memory_versioned_storage>[0]): Promise<{
    service: OldWrapperPurgeService;
    versions: () => number;
  }> {
    const bucket = in_memory_versioned_storage(options);
    const keys = new EnvelopeKeyService(OLD_PASSPHRASE);
    const dek = keys.generate_dek();
    await bucket.storage.put(DEK_KEY, await keys.wrap_dek(dek, 'a'));
    await bucket.storage.put(
      DEK_KEY,
      await new EnvelopeKeyService(NEW_PASSPHRASE).wrap_dek(dek, 'a'),
    );
    const factory = {
      create_storage_only: async (): Promise<TenantStorageContext> => ({
        tenant_id: 'a',
        storage: bucket.storage,
      }),
    } as unknown as TenantContextFactory;
    const config = { encryption_passphrase: NEW_PASSPHRASE } as AtlasConfig;
    return {
      service: new OldWrapperPurgeService(factory, config, new StorageOwnerLeases()),
      versions: () => bucket.versions(DEK_KEY).length,
    };
  }

  it('deletes nothing, and does not report clean, when the listing omits currency', async () => {
    const rig = await limited_rig({ without_is_latest: true });

    const report = await rig.service.purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [OLD_PASSPHRASE],
    });

    expect(report.outcomes[0]).toMatchObject({ status: 'failed', versions: [] });
    expect(report.complete).toBe(false);
    expect(rig.versions()).toBe(2);
  });

  it('refuses when the adapter cannot read old versions', async () => {
    const rig = await limited_rig({ without_get_version: true });

    const report = await rig.service.purge_old_wrappers({
      tenant_ids: ['a'],
      previous_passphrases: [OLD_PASSPHRASE],
    });

    expect(report.outcomes[0]).toMatchObject({ status: 'failed' });
    expect(rig.versions()).toBe(2);
  });
});
