import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * A key-bound AES-256-GCM pair for exercising the streaming read path.
 *
 * {@link stub_tenant_create_decipher} uses a throwaway key, which is enough for
 * control-flow assertions but cannot round-trip. Verifying an object means
 * hashing what actually comes back out, so a test that asserts a checksum
 * match needs the same key on both sides.
 */
export interface StubEncryptedObjectStore {
  /** Encrypts as Atlas stores it: 12-byte IV, 16-byte auth tag, then ciphertext. */
  encrypt(plaintext: Buffer): Buffer;
  /** A `TenantContext.create_decipher` bound to the same key. */
  create_decipher(iv: Buffer, auth_tag: Buffer): DecipherGCM;
  /** An `ObjectStorage.get_stream` serving `stored` in fixed-size chunks. */
  stream(stored: Buffer, chunk_size?: number): Readable;
}

/** Builds an encrypt/decrypt pair sharing one random key, for streaming round-trips. */
export function stub_encrypted_object_store(): StubEncryptedObjectStore {
  const key = randomBytes(32);

  return {
    encrypt(plaintext: Buffer): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },

    create_decipher(iv: Buffer, auth_tag: Buffer): DecipherGCM {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAuthTag(auth_tag);
      return decipher;
    },

    stream(stored: Buffer, chunk_size = 64 * 1024): Readable {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < stored.length; offset += chunk_size) {
        chunks.push(stored.subarray(offset, Math.min(offset + chunk_size, stored.length)));
      }
      return Readable.from(chunks);
    },
  };
}
