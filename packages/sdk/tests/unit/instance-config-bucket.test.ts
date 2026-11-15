import { describe, expect, it } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type { AtlasInstanceConfig } from '@wisecom/atlas-types';
import { normalize_config } from '@/instance-config';

// Issue #768: `s3Bucket` replaces the derived bucket name, bound to the instance's tenant.

const BASE: AtlasInstanceConfig = {
  tenantId: 'tenant-example',
  clientId: 'client-example',
  clientSecret: '<redacted>',
  s3Endpoint: 'https://storage.example.com',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

describe('normalize_config s3Bucket', () => {
  it('leaves the bucket derived when s3Bucket is omitted', () => {
    expect(normalize_config(BASE)).not.toHaveProperty('s3_bucket');
  });

  it('binds s3Bucket to tenantId, exclusive to this instance', () => {
    expect(normalize_config({ ...BASE, s3Bucket: 'tenant-copy' }).s3_bucket).toEqual({
      run: {
        tenant_id: 'tenant-example',
        bucket: 'tenant-copy',
        exclusive: true,
        set_by: 's3Bucket',
      },
      profiles: [],
    });
  });

  it.each<[string, unknown]>([
    ['blank', '  '],
    ['not a string', 42],
    ['uppercase', 'Tenant-Copy'],
    ['too short', 'ab'],
  ])('rejects an s3Bucket that is %s', (_label, value) => {
    expect(() => normalize_config({ ...BASE, s3Bucket: value as string })).toThrow(ConfigError);
  });
});
