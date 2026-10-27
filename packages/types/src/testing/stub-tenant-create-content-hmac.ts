import { createHmac, type Hmac } from 'node:crypto';

/**
 * Returns a keyed hash for use as `TenantContext.create_content_hmac` in unit tests.
 *
 * The key is fixed so one plaintext names the same object on every call, which dedup assertions
 * rely on. It is a test constant with no security value; use a real tenant context to exercise
 * the derived naming key.
 */
export function stub_tenant_create_content_hmac(): Hmac {
  return createHmac('sha256', Buffer.alloc(32, 0x5a));
}
