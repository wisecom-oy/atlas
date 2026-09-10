import { createCipheriv, randomBytes, type CipherGCM } from 'node:crypto';

/**
 * Returns a fresh AES-256-GCM cipher for use as `TenantContext.create_cipher` in unit tests.
 *
 * The scope is accepted and ignored: the key is random, so this is for wiring and control-flow
 * assertions rather than round-trips, and a test that needs the real binding wants
 * `stub_encrypted_object_store`.
 */
export function stub_tenant_create_cipher(_scope_key?: string): {
  cipher: CipherGCM;
  iv: Buffer;
  header: Buffer;
} {
  const iv = randomBytes(12);
  const key = randomBytes(32);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  return { cipher, iv, header: Buffer.alloc(0) };
}
