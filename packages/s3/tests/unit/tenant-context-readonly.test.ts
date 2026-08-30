import { BucketCache } from '@/adapters/bucket-cache';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import { EnvelopeKeyService } from '@wisecom/atlas-core';
import type { AtlasConfig } from '@wisecom/atlas-core';

// Regression tests for issue #93: browsing a tenant must not provision it.
// A read-only context issues no CreateBucket and no PutObject, so a mistyped
// -t leaves no bucket and no key material behind, and read-only credentials
// need neither s3:CreateBucket nor write access to _meta/.

const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const CONFIG = { encryption_passphrase: 'unit-test-passphrase-long' } as AtlasConfig;

interface CommandLike {
  input: { Key?: string; Bucket?: string };
}

function make_s3(objects: Map<string, Buffer>) {
  const send = vi.fn(async (cmd: CommandLike) => {
    const name = cmd.constructor.name;
    const key = cmd.input.Key ?? '';

    if (name === 'GetObjectCommand') {
      const data = objects.get(key);
      if (!data) {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { Body: { transformToByteArray: async () => new Uint8Array(data) } };
    }
    throw new Error(`Unexpected command in read-only path: ${name}`);
  });

  return { send };
}

function stored_dek(): { objects: Map<string, Buffer>; plaintext: Buffer } {
  const key_service = new EnvelopeKeyService(CONFIG.encryption_passphrase);
  const dek = key_service.generate_dek();
  const objects = new Map([['_meta/dek.enc', key_service.wrap_dek(dek, TENANT_ID)]]);
  key_service.destroy();
  return { objects, plaintext: dek };
}

describe('read-only tenant context (issue #93)', () => {
  let buckets: BucketCache;
  beforeEach(() => {
    buckets = new BucketCache();
  });

  it('loads an existing tenant without CreateBucket, HeadBucket, or PutObject', async () => {
    const { objects } = stored_dek();
    const s3 = make_s3(objects);
    const ctx = await new DefaultTenantContextFactory(s3 as never, CONFIG, buckets).create_readonly(
      TENANT_ID,
    );

    const commands = s3.send.mock.calls.map(([cmd]) => cmd.constructor.name);
    expect(commands).toEqual(['GetObjectCommand']);
    ctx.destroy();
  });

  it('decrypts data encrypted with the tenant DEK', async () => {
    const { objects } = stored_dek();
    const factory = new DefaultTenantContextFactory(make_s3(objects) as never, CONFIG, buckets);
    const ctx = await factory.create_readonly(TENANT_ID);

    expect(ctx.decrypt(ctx.encrypt(Buffer.from('payload'))).toString()).toBe('payload');
    ctx.destroy();
  });

  it('reports that no backups exist instead of generating a DEK', async () => {
    const s3 = make_s3(new Map());
    const factory = new DefaultTenantContextFactory(s3 as never, CONFIG, buckets);

    await expect(factory.create_readonly(TENANT_ID)).rejects.toThrow(
      `No backups found for tenant ${TENANT_ID}`,
    );
    const commands = s3.send.mock.calls.map(([cmd]) => cmd.constructor.name);
    expect(commands).toEqual(['GetObjectCommand']);
  });

  it('reports that no backups exist when the bucket itself is absent', async () => {
    const s3 = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('NoSuchBucket'), {
          name: 'NoSuchBucket',
          $metadata: { httpStatusCode: 404 },
        });
      }),
    };
    const factory = new DefaultTenantContextFactory(s3 as never, CONFIG, buckets);

    await expect(factory.create_readonly(TENANT_ID)).rejects.toThrow(
      `No backups found for tenant ${TENANT_ID}`,
    );
  });

  it('surfaces a credential failure as itself, not as "no backups"', async () => {
    const s3 = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('The request signature we calculated does not match'), {
          name: 'SignatureDoesNotMatch',
          $metadata: { httpStatusCode: 403 },
        });
      }),
    };
    const factory = new DefaultTenantContextFactory(s3 as never, CONFIG, buckets);

    await expect(factory.create_readonly(TENANT_ID)).rejects.toThrow('signature');
  });
});
