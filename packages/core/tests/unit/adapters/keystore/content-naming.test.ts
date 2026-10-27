import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';

// Regression tests for issue #446: object names must be keyed, so a bucket reader cannot test a
// guessed plaintext against a stored name.

describe('content naming key (issue #446)', () => {
  const service = new EnvelopeKeyService('test-passphrase');
  const content = Buffer.from('quarterly report body');

  it('derives a 32-byte naming key that is deterministic for one DEK', () => {
    const dek = randomBytes(32);
    const first = service.derive_naming_key(dek);
    expect(first).toHaveLength(32);
    expect(service.derive_naming_key(dek).equals(first)).toBe(true);
  });

  it('derives a different naming key for a different DEK', () => {
    const a = service.derive_naming_key(randomBytes(32));
    const b = service.derive_naming_key(randomBytes(32));
    expect(a.equals(b)).toBe(false);
  });

  it('keeps the naming key separate from the DEK it came from', () => {
    const dek = randomBytes(32);
    expect(service.derive_naming_key(dek).equals(dek)).toBe(false);
  });

  it('names content with an HMAC, not the plain SHA-256 of the plaintext', () => {
    const naming_key = service.derive_naming_key(randomBytes(32));
    const name = service.create_content_hmac(naming_key).update(content).digest('hex');
    expect(name).not.toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('names the same content identically under the same naming key', () => {
    const naming_key = service.derive_naming_key(randomBytes(32));
    const first = service.create_content_hmac(naming_key).update(content).digest('hex');
    const second = service.create_content_hmac(naming_key).update(content).digest('hex');
    expect(first).toBe(second);
  });

  it('names the same content differently under a different naming key', () => {
    const a = service.derive_naming_key(randomBytes(32));
    const b = service.derive_naming_key(randomBytes(32));
    const name_a = service.create_content_hmac(a).update(content).digest('hex');
    const name_b = service.create_content_hmac(b).update(content).digest('hex');
    expect(name_a).not.toBe(name_b);
  });

  it('is not reproducible from the DEK used directly as the HMAC key', () => {
    const dek = randomBytes(32);
    const naming_key = service.derive_naming_key(dek);
    const name = service.create_content_hmac(naming_key).update(content).digest('hex');
    expect(name).not.toBe(createHmac('sha256', dek).update(content).digest('hex'));
  });

  it('produces a 64-character hex name suitable for a storage key segment', () => {
    const naming_key = service.derive_naming_key(randomBytes(32));
    const name = service.create_content_hmac(naming_key).update(content).digest('hex');
    expect(name).toMatch(/^[0-9a-f]{64}$/);
  });
});
