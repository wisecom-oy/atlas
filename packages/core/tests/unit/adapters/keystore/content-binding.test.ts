import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { CONTENT_HEADER_LENGTH, CONTENT_MAGIC } from '@/adapters/keystore/content-envelope';

/**
 * Issue #350: one DEK covers a whole tenant and nothing tied a ciphertext to the object it belongs
 * to, so any blob authenticated in any other blob's place. Overwriting one stored object with
 * another needed write access to the bucket, not the passphrase.
 */

const PASSPHRASE = 'test-passphrase';
const OWNER_A = 'onedrive/data/owner-a/abc';
const OWNER_B = 'onedrive/data/owner-b/def';
const SAME_SCOPE = 'onedrive/data/owner-a/zzz';
const STAGING = 'onedrive/staging/owner-a/item-1-9f2c';

function service(): { svc: EnvelopeKeyService; dek: Buffer } {
  const svc = new EnvelopeKeyService(PASSPHRASE);
  return { svc, dek: svc.generate_dek() };
}

describe('content scope binding (issue #350)', () => {
  it('refuses a ciphertext moved into another owner place', () => {
    const { svc, dek } = service();
    const stored = svc.encrypt(Buffer.from("owner a's file"), dek, OWNER_A);

    expect(() => svc.decrypt(stored, dek, OWNER_B)).toThrow();
  });

  it('still decrypts from another key in the same directory', () => {
    // The binding is the directory, not the whole key: the large-file pipeline encrypts into a
    // staging key and promotes the object onto a content-addressed key it cannot know yet.
    const { svc, dek } = service();
    const plaintext = Buffer.from('content addressed');
    const stored = svc.encrypt(plaintext, dek, OWNER_A);

    expect(svc.decrypt(stored, dek, SAME_SCOPE)).toEqual(plaintext);
  });

  it('refuses a ciphertext whose header was stripped', () => {
    const { svc, dek } = service();
    const stored = svc.encrypt(Buffer.from('bound'), dek, OWNER_A);

    // Without the header the blob reads as one written before the binding existed, so removing it
    // is the downgrade the header is inside the AAD to prevent.
    const stripped = stored.subarray(CONTENT_HEADER_LENGTH);
    expect(() => svc.decrypt(stripped, dek, OWNER_A)).toThrow();
  });

  it('refuses a version this build does not know', () => {
    const { svc, dek } = service();
    const stored = svc.encrypt(Buffer.from('bound'), dek, OWNER_A);
    stored[CONTENT_MAGIC.length] = 99;

    expect(() => svc.decrypt(stored, dek, OWNER_A)).toThrow(/Unsupported content envelope version/);
  });

  it('reads an object written before the binding existed', () => {
    // Everything already in a bucket has no header and no AAD. It stays readable with no
    // migration step, which is the whole reason the header is optional on read.
    const { svc, dek } = service();
    const plaintext = Buffer.from('written by an older Atlas');
    const legacy = legacy_encrypt(plaintext, dek);

    expect(svc.decrypt(legacy, dek, OWNER_A)).toEqual(plaintext);
  });

  it('binds a streamed object to the directory it is promoted into', () => {
    const { svc, dek } = service();
    const plaintext = Buffer.from('streamed through staging');

    // What the large-file pipeline does: encrypt for the canonical directory while writing to a
    // staging key, then read the finished object back from its canonical key.
    const { cipher, iv, header } = svc.create_encrypt_cipher(dek, OWNER_A);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const auth_tag = cipher.getAuthTag();

    const readable = svc.create_decrypt_decipher(dek, iv, auth_tag, SAME_SCOPE, header);
    expect(Buffer.concat([readable.update(body), readable.final()])).toEqual(plaintext);

    const wrong_scope = svc.create_decrypt_decipher(dek, iv, auth_tag, STAGING, header);
    expect(() => Buffer.concat([wrong_scope.update(body), wrong_scope.final()])).toThrow();
  });
});

/** The envelope as it was written before the scope binding: IV, auth tag, ciphertext, no AAD. */
function legacy_encrypt(plaintext: Buffer, dek: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
