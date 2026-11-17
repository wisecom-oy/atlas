import { describe, it, expect, vi } from 'vitest';
import { EnvelopeKeyService } from '@wisecom/atlas-core';
import type { AtlasConfig, BucketSelection } from '@wisecom/atlas-core';
import { ConfigError, NotFoundError } from '@wisecom/atlas-types';
import { BucketCache } from '@/adapters/bucket-cache';
import { ConfiguredBucketNameResolver } from '@/adapters/configured-bucket-name-resolver';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';

// Issue #768: the tenant context factory reads and writes the configured bucket, never creates
// it, and never opens another tenant through it.

const PROD = 'tid-prod';
const DR = 'tid-dr';
const PASSPHRASE = 'unit-test-passphrase-long';
const CONFIG = { encryption_passphrase: PASSPHRASE } as AtlasConfig;

interface CommandLike {
  input: { Key?: string; Bucket?: string };
}

function missing(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

/** An S3 fake holding `buckets`, each a map of key to bytes, that records every request. */
function fake_s3(buckets: Record<string, Map<string, Buffer>>) {
  const send = vi.fn(async (cmd: CommandLike) => {
    const name = cmd.constructor.name;
    const objects = buckets[cmd.input.Bucket ?? ''];
    if (name === 'CreateBucketCommand') throw new Error('CreateBucket must never be sent');
    if (objects === undefined)
      throw missing(name === 'HeadBucketCommand' ? 'NotFound' : 'NoSuchBucket');
    if (name === 'HeadBucketCommand') return {};
    const data = objects.get(cmd.input.Key ?? '');
    if (name === 'HeadObjectCommand') {
      if (!data) throw missing('NotFound');
      return {};
    }
    if (name === 'GetObjectCommand') {
      if (!data) throw missing('NoSuchKey');
      return { Body: { transformToByteArray: async () => new Uint8Array(data) } };
    }
    throw new Error(`Unexpected command: ${name}`);
  });
  const requests = (): [string, string | undefined][] =>
    send.mock.calls.map(([cmd]) => [cmd.constructor.name, cmd.input.Bucket]);
  return { send, requests };
}

async function bucket_with_key(tenant_id: string): Promise<Map<string, Buffer>> {
  const key_service = new EnvelopeKeyService(PASSPHRASE);
  const dek = key_service.generate_dek();
  const wrapped = await key_service.wrap_dek(dek, tenant_id);
  key_service.destroy();
  return new Map([['_meta/dek.enc', wrapped]]);
}

function factory_for(s3: { send: unknown }, selection: BucketSelection) {
  return new DefaultTenantContextFactory(
    s3 as never,
    CONFIG,
    new BucketCache(),
    new ConfiguredBucketNameResolver(selection),
  );
}

const ENV_OVERRIDE: BucketSelection = {
  run: { tenant_id: PROD, bucket: 'prod-copy', exclusive: true, set_by: 'ATLAS_S3_BUCKET' },
  profiles: [{ tenant_id: DR, bucket: 'dr-copy' }],
};
const PROFILE_OVERRIDES: BucketSelection = {
  run: { tenant_id: PROD, bucket: 'prod-copy', exclusive: false, set_by: 'tenant profile "prod"' },
  profiles: [
    { tenant_id: PROD, bucket: 'prod-copy' },
    { tenant_id: DR, bucket: 'dr-copy' },
  ],
};

describe('tenant context with a bucket override (issue #768)', () => {
  it('opens the copy read-only with the tenant id as the key salt, writing nothing', async () => {
    const s3 = fake_s3({ 'prod-copy': await bucket_with_key(PROD) });

    const ctx = await factory_for(s3, ENV_OVERRIDE).create_readonly(PROD);

    expect(s3.requests()).toEqual([['GetObjectCommand', 'prod-copy']]);
    ctx.destroy();
  });

  it('opens an existing configured bucket for writing without CreateBucket', async () => {
    const s3 = fake_s3({ 'prod-copy': await bucket_with_key(PROD) });

    const ctx = await factory_for(s3, ENV_OVERRIDE).create(PROD);

    const names = s3.requests().map(([name]) => name);
    expect(names[0]).toBe('HeadBucketCommand');
    expect(names).not.toContain('CreateBucketCommand');
    expect(s3.requests().every(([, bucket]) => bucket === 'prod-copy')).toBe(true);
    ctx.destroy();
  });

  it('refuses a missing configured bucket instead of creating it, on every open path', async () => {
    const s3 = fake_s3({});
    const factory = factory_for(s3, ENV_OVERRIDE);

    await expect(factory.create(PROD)).rejects.toThrow(
      /Bucket "prod-copy" is configured for tenant tid-prod but does not exist/,
    );
    await expect(factory.create_readonly(PROD)).rejects.toBeInstanceOf(ConfigError);
    await expect(factory.create_storage_only(PROD)).rejects.toBeInstanceOf(ConfigError);
    expect(s3.requests().map(([name]) => name)).not.toContain('CreateBucketCommand');
  });

  it('still reports an empty configured bucket as a tenant without backups', async () => {
    const s3 = fake_s3({ 'prod-copy': new Map() });

    await expect(factory_for(s3, ENV_OVERRIDE).create_readonly(PROD)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses another tenant under ATLAS_S3_BUCKET before any request (tenant delete -t, keys)', async () => {
    const s3 = fake_s3({
      'prod-copy': new Map(),
      'dr-copy': new Map(),
      [`atlas-${DR}`]: new Map(),
    });
    const factory = factory_for(s3, ENV_OVERRIDE);

    await expect(factory.create_storage_only(DR)).rejects.toThrow(/refuses to open tenant tid-dr/);
    await expect(factory.create_readonly(DR)).rejects.toBeInstanceOf(ConfigError);
    await expect(factory.create(DR)).rejects.toBeInstanceOf(ConfigError);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("opens another tenant in its own profile's bucket, never the run's", async () => {
    const s3 = fake_s3({ 'prod-copy': new Map(), 'dr-copy': new Map() });

    const ctx = await factory_for(s3, PROFILE_OVERRIDES).create_storage_only(DR);

    expect(s3.requests()).toEqual([['HeadBucketCommand', 'dr-copy']]);
    expect(ctx.tenant_id).toBe(DR);
  });
});
