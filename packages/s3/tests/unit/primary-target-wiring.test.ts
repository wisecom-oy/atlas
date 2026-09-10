import { describe, it, expect } from 'vitest';
import { create_primary_target } from '@wisecom/atlas-core/services/replication/primary-target-factory';
import type { AtlasConfig } from '@wisecom/atlas-core/utils/config';
import { create_storage_target } from '@/adapters/storage-target.factory';

/**
 * The seam between `create_primary_target` and the real factory.
 *
 * Both sides are bound by symbol in the container, which inversify does not typecheck, so the two
 * spelled the same shape differently for a whole release: the factory read camelCase and the
 * caller sent snake_case. Every field arrived undefined, and rehydrate died inside the AWS SDK
 * with "Resolved credential object is not valid" while unit tests, using their own stub factories,
 * stayed green (issue #377).
 */
const config: AtlasConfig = {
  tenant_id: 'tenant-1',
  client_id: 'client-1',
  client_secret: 'secret-1',
  s3_endpoint: 'http://primary:9000',
  s3_access_key: 'primary-access',
  s3_secret_key: 'primary-secret',
  s3_region: 'eu-north-1',
  encryption_passphrase: 'a-passphrase-long-enough',
};

describe('create_primary_target against the real factory', () => {
  it('opens the endpoint the tenant config names', () => {
    const target = create_primary_target(create_storage_target, config);

    expect(target.endpoint).toBe('http://primary:9000');
  });

  it('derives a stable target id from the endpoint and region', () => {
    const first = create_primary_target(create_storage_target, config);
    const second = create_primary_target(create_storage_target, config);
    const elsewhere = create_primary_target(create_storage_target, {
      ...config,
      s3_endpoint: 'http://replica:9002',
    });

    expect(first.target_id).toHaveLength(16);
    expect(second.target_id).toBe(first.target_id);
    expect(elsewhere.target_id).not.toBe(first.target_id);
  });
});
