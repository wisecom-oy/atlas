import type { CipherGCM } from 'node:crypto';

import type { ObjectStorage } from '@/ports/storage/object-storage.port';

/** Tenant-scoped object storage accessor. */
export interface TenantStorageContext {
  readonly tenant_id: string;
  readonly storage: ObjectStorage;
}

/** Tenant-scoped encryption/decryption operations. */
export interface TenantCryptoContext {
  /** Encrypts plaintext with this tenant's data encryption key. */
  encrypt(data: Buffer): Buffer;

  /** Decrypts ciphertext with this tenant's data encryption key. */
  decrypt(data: Buffer): Buffer;

  /**
   * Creates a streaming AES-256-GCM cipher and IV for payloads that match
   * the non-streaming {@link TenantCryptoContext.encrypt} envelope layout on read.
   */
  create_cipher(): { cipher: CipherGCM; iv: Buffer };
}

/** Bundles tenant-scoped storage and encryption for a single tenant. */
export interface TenantContext extends TenantStorageContext, TenantCryptoContext {}

/** Factory that initializes per-tenant infrastructure (bucket, DEK) on demand. */
export interface TenantContextFactory {
  create(tenant_id: string): Promise<TenantContext>;
}
