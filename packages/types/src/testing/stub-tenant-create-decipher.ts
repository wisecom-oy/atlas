import { createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';

/**
 * Returns an AES-256-GCM decipher for use as `TenantContext.create_decipher` in unit tests.
 * The key is random, so this is for wiring and control-flow assertions, not round-trips.
 */
export function stub_tenant_create_decipher(iv: Buffer, auth_tag: Buffer): DecipherGCM {
  const decipher = createDecipheriv('aes-256-gcm', randomBytes(32), iv, { authTagLength: 16 });
  decipher.setAuthTag(auth_tag);
  return decipher;
}
