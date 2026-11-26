/**
 * Issue #974: `checkStorage()` and `atlas storage-check` name the writer-exclusion mode in effect,
 * which the container takes from `writer_exclusion` in the configuration.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'inversify';
import { S3Client } from '@aws-sdk/client-s3';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { STORAGE_CHECK_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import type { StorageCheckUseCase, WriterExclusionMode } from '@wisecom/atlas-types';
import { ConditionalWritePolicy } from '@/adapters/conditional-write-policy';
import { bind_s3_storage } from '@/container';

// The probe writes objects and has its own tests; here only its verdict matters.
vi.mock('@/adapters/s3-conditional-write-probe', () => ({
  probe_conditional_writes: vi.fn(async () => ({
    support: 'ignored',
    violations: ['create_only'],
  })),
}));

const BASE = {
  tenant_id: 'tenant-1',
  client_id: 'client',
  client_secret: '<redacted>',
  s3_endpoint: 'https://s3.example.invalid',
  s3_access_key: '<redacted>',
  s3_secret_key: '<redacted>',
  s3_region: 'us-east-1',
  encryption_passphrase: '<redacted>',
} satisfies AtlasConfig;

function container_for(config: AtlasConfig): Container {
  const container = new Container();
  bind_s3_storage(container, config);
  return container;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage check writer-exclusion mode (issue #974)', () => {
  it.each<[string, WriterExclusionMode | undefined, WriterExclusionMode]>([
    ['the default', undefined, 'storage_lease'],
    ['the single-writer opt-in', 'single_writer', 'single_writer'],
    ['a host exclusion', 'host_exclusion', 'host_exclusion'],
  ])('reports %s', async (_name, configured, reported) => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({}) as never);
    const container = container_for({ ...BASE, writer_exclusion: configured });

    const result = await container
      .get<StorageCheckUseCase>(STORAGE_CHECK_USE_CASE_TOKEN)
      .check_storage('tenant-1');

    expect(result.writer_exclusion).toBe(reported);
    expect(result.conditional_writes.support).toBe('ignored');
  });

  it('binds one policy per container, which checks conditions only in an opt-in mode', () => {
    const default_policy = container_for(BASE).get(ConditionalWritePolicy);
    const opt_in_policy = container_for({ ...BASE, writer_exclusion: 'single_writer' }).get(
      ConditionalWritePolicy,
    );

    expect(default_policy.emulates_conditions()).toBe(false);
    expect(opt_in_policy.emulates_conditions()).toBe(true);
  });
});
