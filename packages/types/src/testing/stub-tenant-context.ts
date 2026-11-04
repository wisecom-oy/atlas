import type { TenantContext } from '@/ports/tenant/context.port';
import { stub_storage_target } from '@/testing/stub-storage-target';
import { stub_tenant_create_content_hmac } from '@/testing/stub-tenant-create-content-hmac';

/** A tenant context stub whose objects live in the `objects` map, stored in plaintext. */
export interface StubTenantContext {
  readonly ctx: TenantContext;
  readonly objects: Record<string, Buffer>;
}

/**
 * An in-memory tenant context: objects are stored in plaintext, so tests can read what a service
 * wrote. Only the members the services call are provided; the rest of the crypto surface is unused.
 */
export function stub_tenant_context(objects: Record<string, Buffer> = {}): StubTenantContext {
  const { storage } = stub_storage_target({ objects });
  const ctx = {
    tenant_id: 'tenant-1',
    storage,
    encrypt: (data: Buffer) => data,
    decrypt: (data: Buffer) => data,
    create_content_hmac: stub_tenant_create_content_hmac,
    destroy: () => undefined,
  } as unknown as TenantContext;
  return { ctx, objects };
}
