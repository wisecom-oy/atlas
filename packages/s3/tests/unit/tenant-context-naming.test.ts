import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EnvelopeKeyService } from '@wisecom/atlas-core';
import type { TenantContext } from '@wisecom/atlas-types';
import { build_context } from '@/adapters/tenant-context.factory';
import type { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';

// Regression tests for issue #446: a tenant context names content with a keyed hash, so the
// names are stable for one tenant key (dedup across runs) and unusable without it.

const storage = {} as S3ObjectStorage;
const content = Buffer.from('mailbox payload');

function name_in(ctx: TenantContext, data: Buffer): string {
  return ctx.create_content_hmac().update(data).digest('hex');
}

describe('tenant context content naming (issue #446)', () => {
  it('names the same content identically in two contexts sharing one DEK', () => {
    const dek = randomBytes(32);
    const key_service = new EnvelopeKeyService('unit-test-passphrase-long');
    const first = build_context('tenant-1', storage, key_service, dek);
    const second = build_context('tenant-1', storage, key_service, dek);
    expect(name_in(first, content)).toBe(name_in(second, content));
  });

  it('names the same content differently under a different DEK', () => {
    const key_service = new EnvelopeKeyService('unit-test-passphrase-long');
    const a = build_context('tenant-1', storage, key_service, randomBytes(32));
    const b = build_context('tenant-1', storage, key_service, randomBytes(32));
    expect(name_in(a, content)).not.toBe(name_in(b, content));
  });

  it('throws instead of naming content after the context is destroyed', () => {
    const key_service = new EnvelopeKeyService('unit-test-passphrase-long');
    const ctx = build_context('tenant-1', storage, key_service, randomBytes(32));
    ctx.destroy();
    expect(() => ctx.create_content_hmac()).toThrow(/destroyed/);
  });
});
