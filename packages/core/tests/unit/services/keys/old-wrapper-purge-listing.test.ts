import { describe, expect, it } from 'vitest';
import type { ObjectStorage, StorageObjectVersion } from '@wisecom/atlas-types';
import { purge_tenant_old_wrappers } from '@/services/keys/wrapper-version-purge';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { DEK_KEY, NEW_PASSPHRASE, OLD_PASSPHRASE, key_set_rig } from './key-set-rig';

/**
 * The purge deletes old versions only when the listing proves which wrapper is current, and it
 * never reports a bucket clean while old wrappers remain (PR #770).
 */

async function rotated_storage(): Promise<{ storage: ObjectStorage; versions: () => number }> {
  const rig = await key_set_rig({ a: OLD_PASSPHRASE });
  await rig.rewrap_as('a', NEW_PASSPHRASE);
  const bucket = rig.tenants.get('a')!.bucket;
  return { storage: bucket.storage, versions: () => bucket.versions(DEK_KEY).length };
}

function purge_keys(): Parameters<typeof purge_tenant_old_wrappers>[2] {
  return {
    configured: new EnvelopeKeyService(NEW_PASSPHRASE),
    previous: [new EnvelopeKeyService(OLD_PASSPHRASE)],
  };
}

describe('purge_tenant_old_wrappers and the version listing', () => {
  it('deletes nothing when no listed version is marked current', async () => {
    const { storage, versions } = await rotated_storage();
    const list = storage.list_versions.bind(storage);
    storage.list_versions = async (prefix: string): Promise<StorageObjectVersion[]> =>
      (await list(prefix)).map((v) => ({ ...v, is_latest: false }));

    const outcome = await purge_tenant_old_wrappers(storage, 'a', purge_keys());

    expect(outcome).toMatchObject({ status: 'failed', versions: [] });
    expect(versions()).toBe(2);
  });

  it('deletes nothing when two listed versions are marked current', async () => {
    const { storage, versions } = await rotated_storage();
    const list = storage.list_versions.bind(storage);
    storage.list_versions = async (prefix: string): Promise<StorageObjectVersion[]> =>
      (await list(prefix)).map((v) => ({ ...v, is_latest: true }));

    const outcome = await purge_tenant_old_wrappers(storage, 'a', purge_keys());

    expect(outcome).toMatchObject({ status: 'failed', versions: [] });
    expect(versions()).toBe(2);
  });

  it('reports old wrappers behind a missing current wrapper as left, and keeps them', async () => {
    const { storage, versions } = await rotated_storage();
    // A delete marker over `_meta/dek.enc`: HEAD finds nothing, the old versions are still listed.
    storage.exists = async (key: string): Promise<boolean> => key !== DEK_KEY;
    const list = storage.list_versions.bind(storage);
    storage.list_versions = async (prefix: string): Promise<StorageObjectVersion[]> => [
      ...(await list(prefix)).map((v) => ({ ...v, is_latest: false })),
      { key: DEK_KEY, version_id: 'marker', is_delete_marker: true, is_latest: true },
    ];

    const outcome = await purge_tenant_old_wrappers(storage, 'a', purge_keys());

    expect(outcome.status).toBe('versions_left');
    expect(outcome.versions.map((v) => v.status)).toEqual(['unverified', 'unverified']);
    expect(versions()).toBe(2);
  });

  it('still reports no key when the bucket holds no wrapper version at all', async () => {
    const rig = await key_set_rig({ empty: null });

    const outcome = await purge_tenant_old_wrappers(
      rig.tenants.get('empty')!.bucket.storage,
      'empty',
      purge_keys(),
    );

    expect(outcome).toEqual({ tenant_id: 'empty', status: 'no_key', versions: [] });
  });
});
