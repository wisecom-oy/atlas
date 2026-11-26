/**
 * Issue #974 at the tenant: in an opt-in writer-exclusion mode the data key and the identity
 * registry are written on a backend that ignores or rejects conditional writes, with no header
 * sent, no probe run, and the tenant scope held while a new data key is created.
 */
import { describe, expect, it } from 'vitest';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { ExclusionOwnerLeases } from '@wisecom/atlas-core/services/lease/exclusion-owner-leases';
import { InProcessOwnerExclusion } from '@wisecom/atlas-core/services/lease/in-process-owner-exclusion';
import { OwnerBusyError } from '@wisecom/atlas-types';
import type { IdentityRegistry, OwnerExclusion, OwnerExclusionRequest } from '@wisecom/atlas-types';
import { BucketCache } from '@/adapters/bucket-cache';
import { ConditionalWritePolicy } from '@/adapters/conditional-write-policy';
import { ConfiguredBucketNameResolver } from '@/adapters/configured-bucket-name-resolver';
import { S3IdentityRegistryRepository } from '@/adapters/s3-identity-registry-repository.adapter';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import {
  IGNORING,
  REJECTING,
  fake_conditional_s3,
  type ConditionalBehaviour,
} from './fake-conditional-s3';

const CONFIG = { encryption_passphrase: 'unit-test-passphrase-long' } as AtlasConfig;
const DEK_KEY = '_meta/dek.enc';

/** An in-process exclusion that also records what Atlas asked of it. */
function recording_exclusion(): { exclusion: OwnerExclusion; requests: OwnerExclusionRequest[] } {
  const inner = new InProcessOwnerExclusion();
  const requests: OwnerExclusionRequest[] = [];
  return {
    requests,
    exclusion: {
      acquire: (request) => {
        requests.push(request);
        return inner.acquire(request);
      },
    },
  };
}

function opt_in_factory(
  s3: { send: unknown },
  exclusion: OwnerExclusion,
  policy = new ConditionalWritePolicy('host_exclusion'),
): DefaultTenantContextFactory {
  return new DefaultTenantContextFactory(
    s3 as never,
    CONFIG,
    new BucketCache(),
    new ConfiguredBucketNameResolver(undefined),
    policy,
    new ExclusionOwnerLeases(exclusion),
  );
}

function registry_adding(email: string) {
  return (current: IdentityRegistry | undefined): IdentityRegistry => ({
    tenant_id: 'tenant-1',
    entries: [
      ...(current?.entries ?? []),
      {
        object_id: email,
        email,
        display_name: email,
        registered_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
      },
    ],
  });
}

const BACKENDS: ReadonlyArray<[string, ConditionalBehaviour]> = [
  ['ignores the conditions', IGNORING],
  ['rejects the conditions with 501', REJECTING],
];

describe.each(BACKENDS)('tenant writes on a backend that %s (issue #974)', (_name, kind) => {
  it('creates the data key under the tenant scope, with no condition sent and no probe', async () => {
    const s3 = fake_conditional_s3(kind);
    const { exclusion, requests } = recording_exclusion();

    const ctx = await opt_in_factory(s3, exclusion).create('tenant-1');

    expect(s3.objects.has(DEK_KEY)).toBe(true);
    expect(s3.conditional_puts()).toBe(0);
    expect(s3.probes_started()).toBe(0);
    expect(requests).toEqual([
      { tenantId: 'tenant-1', workload: 'tenant', ownerId: 'tenant-1', operation: 'bootstrap' },
    ]);
    ctx.destroy();
  });

  it('gives concurrent first runs in one process the same data key, written once', async () => {
    const s3 = fake_conditional_s3(kind);
    const { exclusion } = recording_exclusion();
    const policy = new ConditionalWritePolicy('single_writer');
    const factory = opt_in_factory(s3, exclusion, policy);

    const contexts = await Promise.all([1, 2, 3].map(() => factory.create('tenant-1')));

    const sealed = contexts[0]!.encrypt(Buffer.from('hello'), 'probe/key');
    for (const ctx of contexts) {
      expect(ctx.decrypt(sealed, 'probe/key').toString()).toBe('hello');
    }
    expect(s3.put_keys().filter((key) => key === DEK_KEY)).toHaveLength(1);
    for (const ctx of contexts) ctx.destroy();
  });

  it('writes no data key when the host refuses the tenant scope', async () => {
    const s3 = fake_conditional_s3(kind);
    const busy: OwnerExclusion = {
      acquire: async () => ({ acquired: false, heldByOperation: 'backup' }),
    };

    await expect(opt_in_factory(s3, busy).create('tenant-1')).rejects.toBeInstanceOf(
      OwnerBusyError,
    );
    expect(s3.objects.has(DEK_KEY)).toBe(false);
  });

  it('keeps every entry when several runs in one process register users at once', async () => {
    const s3 = fake_conditional_s3(kind);
    const { exclusion } = recording_exclusion();
    const ctx = await opt_in_factory(s3, exclusion).create('tenant-1');
    const registry = new S3IdentityRegistryRepository();
    const emails = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'];

    await Promise.all(emails.map((email) => registry.update(ctx, registry_adding(email))));

    const stored = await registry.load(ctx);
    expect(stored?.entries.map((entry) => entry.email).sort()).toEqual(emails);
    expect(s3.conditional_puts()).toBe(0);
    ctx.destroy();
  });
});
