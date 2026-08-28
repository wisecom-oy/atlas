import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import {
  stream_decrypt_from_storage,
  stream_sha256_from_storage,
} from '@/services/shared/stream-decrypt';

const KEY = randomBytes(32);

/**
 * Encrypts a payload the way Atlas stores it: 12-byte IV, 16-byte auth tag,
 * then ciphertext.
 */
function encrypt(plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Builds a context whose storage streams `stored` back in fixed-size chunks. */
function make_ctx(stored: Buffer, chunk_size: number): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: {
      get_stream: async () => {
        const chunks: Buffer[] = [];
        for (let i = 0; i < stored.length; i += chunk_size) {
          chunks.push(stored.subarray(i, Math.min(i + chunk_size, stored.length)));
        }
        return Readable.from(chunks);
      },
    },
    create_decipher: (iv: Buffer, auth_tag: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 });
      decipher.setAuthTag(auth_tag);
      return decipher;
    },
  } as unknown as TenantContext;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

describe('stream_decrypt_from_storage', () => {
  it('decrypts a multi-megabyte object spanning many chunks (issue #143)', async () => {
    const plaintext = randomBytes(9 * 1024 * 1024);
    const ctx = make_ctx(encrypt(plaintext), 64 * 1024);

    const result = await stream_decrypt_from_storage(ctx, 'data/owner/checksum');

    expect(result.content.length).toBe(plaintext.length);
    expect(Buffer.compare(result.content, plaintext)).toBe(0);
    expect(result.sha256_hex).toBe(sha256(plaintext));
  });

  it('assembles the IV and auth tag when the header is split across chunks', async () => {
    const plaintext = randomBytes(8 * 1024);
    // 7-byte chunks split the 28-byte header across four reads; the payload
    // stays small because chunk count, not size, is what this case exercises.
    const ctx = make_ctx(encrypt(plaintext), 7);

    const result = await stream_decrypt_from_storage(ctx, 'data/owner/checksum');

    expect(Buffer.compare(result.content, plaintext)).toBe(0);
    expect(result.sha256_hex).toBe(sha256(plaintext));
  });

  it('decrypts a payload delivered as one chunk', async () => {
    const plaintext = randomBytes(1024);
    const stored = encrypt(plaintext);
    const ctx = make_ctx(stored, stored.length);

    const result = await stream_decrypt_from_storage(ctx, 'data/owner/checksum');

    expect(Buffer.compare(result.content, plaintext)).toBe(0);
  });

  it('rejects a stream that ends before the header is complete', async () => {
    const ctx = make_ctx(randomBytes(20), 20);

    await expect(stream_decrypt_from_storage(ctx, 'data/owner/truncated')).rejects.toThrow(
      /expected at least 28/,
    );
  });

  it('rejects when the ciphertext was tampered with', async () => {
    const stored = encrypt(randomBytes(2 * 1024 * 1024));
    stored[stored.length - 1] ^= 0xff;
    const ctx = make_ctx(stored, 64 * 1024);

    await expect(stream_decrypt_from_storage(ctx, 'data/owner/tampered')).rejects.toThrow();
  });
});

describe('stream_sha256_from_storage', () => {
  it('matches the digest of the decrypted plaintext', async () => {
    const plaintext = randomBytes(9 * 1024 * 1024);
    const ctx = make_ctx(encrypt(plaintext), 64 * 1024);

    await expect(stream_sha256_from_storage(ctx, 'data/owner/checksum')).resolves.toBe(
      sha256(plaintext),
    );
  });

  it('agrees with the buffering reader across different chunkings', async () => {
    // Small payload with a tiny chunk size: the point is that chunk boundaries
    // do not change the digest, and 7-byte chunks over megabytes is hundreds of
    // thousands of iterations, which times out on a slow runner rather than
    // testing anything further.
    const stored = encrypt(randomBytes(64 * 1024));

    const buffered = await stream_decrypt_from_storage(make_ctx(stored, 64 * 1024), 'k');
    const streamed = await stream_sha256_from_storage(make_ctx(stored, 7), 'k');

    expect(streamed).toBe(buffered.sha256_hex);
  });

  it('rejects when the ciphertext was tampered with', async () => {
    const stored = encrypt(randomBytes(1024 * 1024));
    stored[stored.length - 1] ^= 0xff;

    await expect(
      stream_sha256_from_storage(make_ctx(stored, 64 * 1024), 'data/owner/tampered'),
    ).rejects.toThrow();
  });
});
