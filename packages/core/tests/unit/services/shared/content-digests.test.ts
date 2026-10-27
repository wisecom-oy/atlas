import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { compute_content_digests } from '@/services/shared/content-digests';

// Must match the fixed key in stub_tenant_create_content_hmac.
const STUB_KEY = Buffer.alloc(32, 0x5a);

const ctx = { create_content_hmac: stub_tenant_create_content_hmac } as unknown as TenantContext;

function sha256_hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function hmac_hex(buf: Buffer): string {
  return createHmac('sha256', STUB_KEY).update(buf).digest('hex');
}

describe('compute_content_digests', () => {
  it('returns the plain SHA-256 checksum and a keyed content name, not the checksum', () => {
    const plaintext = randomBytes(1024);

    const digests = compute_content_digests(ctx, plaintext);

    expect(digests.checksum).toBe(sha256_hex(plaintext));
    expect(digests.content_name).toBe(hmac_hex(plaintext));
    expect(digests.content_name).not.toBe(digests.checksum);
  });

  it('hashes input larger than one slice the same as a single pass', () => {
    const plaintext = Buffer.alloc(64 * 1024 * 1024 + 3, 0x01);

    const digests = compute_content_digests(ctx, plaintext);

    expect(digests.checksum).toBe(sha256_hex(plaintext));
    expect(digests.content_name).toBe(hmac_hex(plaintext));
  });
});
