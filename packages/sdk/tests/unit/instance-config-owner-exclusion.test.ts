/**
 * Issue #974: `ownerExclusion` is the SDK's explicit opt-in. Supplying it selects host exclusion
 * and replaces the storage lease; omitting it leaves the default lease and refusal unchanged.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigError, OWNER_LEASE_TOKEN } from '@wisecom/atlas-types';
import type { AtlasInstanceConfig, OwnerExclusion, OwnerLeasePort } from '@wisecom/atlas-types';
import { ExclusionOwnerLeases } from '@wisecom/atlas-core/services/lease/exclusion-owner-leases';
import { StorageOwnerLeases } from '@wisecom/atlas-core/services/lease/storage-owner-leases';
import { normalize_config } from '@/instance-config';
import { create_container_from_config } from '@/container';
import { createAtlasInstance } from '@/atlas-instance.adapter';

const BASE: AtlasInstanceConfig = {
  tenantId: 'tenant-example',
  clientId: 'client-example',
  clientSecret: '<redacted>',
  s3Endpoint: 'https://storage.example.com',
  s3AccessKey: '<redacted>',
  s3SecretKey: '<redacted>',
  encryptionPassphrase: '<redacted>'.repeat(2),
};

const HOST_EXCLUSION: OwnerExclusion = {
  acquire: async () => ({ acquired: true, release: async () => undefined }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ownerExclusion instance option (issue #974)', () => {
  it('keeps the storage lease when no exclusion is supplied', () => {
    const config = normalize_config(BASE);
    const leases = create_container_from_config(config).get<OwnerLeasePort>(OWNER_LEASE_TOKEN);

    expect(config).not.toHaveProperty('writer_exclusion');
    expect(leases).toBeInstanceOf(StorageOwnerLeases);
  });

  it('selects host exclusion and binds the host exclusion in place of the lease', () => {
    const config = normalize_config({ ...BASE, ownerExclusion: HOST_EXCLUSION });
    const container = create_container_from_config(config, undefined, {}, HOST_EXCLUSION);

    expect(config.writer_exclusion).toBe('host_exclusion');
    expect(container.get<OwnerLeasePort>(OWNER_LEASE_TOKEN)).toBeInstanceOf(ExclusionOwnerLeases);
  });

  it.each([null, {}, { acquire: 'not a function' }])(
    'refuses an exclusion without acquire: %j',
    (exclusion) => {
      expect(() =>
        normalize_config({ ...BASE, ownerExclusion: exclusion as unknown as OwnerExclusion }),
      ).toThrow(ConfigError);
    },
  );

  it.each([
    ['without an exclusion', undefined, 'storage_lease'],
    ['with an exclusion', HOST_EXCLUSION, 'host_exclusion'],
  ] as const)('reports the mode from checkStorage %s', async (_name, exclusion, mode) => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({}) as never);
    const atlas = createAtlasInstance(
      exclusion === undefined ? BASE : { ...BASE, ownerExclusion: exclusion },
    );

    const result = await atlas.checkStorage();

    expect(result.writerExclusion).toBe(mode);
    await atlas.dispose();
  });
});
