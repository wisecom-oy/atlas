/**
 * Issue #915: the first conditional write of a run is the data key bootstrap or the owner lease,
 * so a backend that ignores conditional writes is refused before either is stored.
 */
import { describe, expect, it } from 'vitest';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { BucketCache } from '@/adapters/bucket-cache';
import { ConditionalWritesNotEnforcedError } from '@/adapters/conditional-write.errors';
import { ConfiguredBucketNameResolver } from '@/adapters/configured-bucket-name-resolver';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import { ENFORCING, IGNORING, fake_conditional_s3 } from './fake-conditional-s3';

const CONFIG = { encryption_passphrase: 'unit-test-passphrase-long' } as AtlasConfig;

function factory_over(s3: { send: unknown }, cache: BucketCache): DefaultTenantContextFactory {
  return new DefaultTenantContextFactory(
    s3 as never,
    CONFIG,
    cache,
    new ConfiguredBucketNameResolver(undefined),
  );
}

describe('tenant bootstrap on a backend without conditional writes (issue #915)', () => {
  it('refuses before the data key is written', async () => {
    const s3 = fake_conditional_s3(IGNORING);

    await expect(factory_over(s3, new BucketCache()).create('tenant-1')).rejects.toBeInstanceOf(
      ConditionalWritesNotEnforcedError,
    );
    expect(s3.put_keys()).not.toContain('_meta/dek.enc');
    expect(s3.objects.size).toBe(0);
  });

  it('bootstraps the data key on an enforcing backend and probes the bucket once per process', async () => {
    const s3 = fake_conditional_s3(ENFORCING);
    const cache = new BucketCache();

    const first = await factory_over(s3, cache).create('tenant-1');
    const second = await factory_over(s3, cache).create('tenant-1');
    await (
      await factory_over(s3, cache).create_storage_only('tenant-1')
    ).storage.put(
      '_meta/leases/outlook/owner-1.json',
      Buffer.from('lease'),
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(s3.objects.has('_meta/dek.enc')).toBe(true);
    expect(s3.probes_started()).toBe(1);
    first.destroy();
    second.destroy();
  });
});
