import { createCipheriv, randomBytes, type CipherGCM } from 'node:crypto';

/**
 * Returns a fresh AES-256-GCM cipher for use as `TenantContext.create_cipher` in unit tests.
 */
export function stub_tenant_create_cipher(): { cipher: CipherGCM; iv: Buffer } {
  const iv = randomBytes(12);
  const key = randomBytes(32);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  return { cipher, iv };
}
