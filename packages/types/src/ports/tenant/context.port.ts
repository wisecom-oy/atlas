import type { CipherGCM, DecipherGCM } from 'node:crypto';

import type { ObjectStorage } from '@/ports/storage/object-storage.port';

/** Tenant-scoped object storage accessor. */
export interface TenantStorageContext {
  readonly tenant_id: string;
  readonly storage: ObjectStorage;
}

/**
 * Tenant-scoped encryption and decryption.
 *
 * Every method takes the key the object lives under, because one DEK covers the whole tenant and
 * the ciphertext is bound to its scope: an object moved to another key stops decrypting instead of
 * authenticating in its place (issue #350). The key is required rather than optional, since an
 * optional binding is one a call site forgets and the protection then disappears silently.
 */
export interface TenantCryptoContext {
  /** Encrypts plaintext for the object that will live at `storage_key`. */
  encrypt(data: Buffer, storage_key: string): Buffer;

  /** Decrypts the object read from `storage_key`. */
  decrypt(data: Buffer, storage_key: string): Buffer;

  /**
   * Creates a streaming AES-256-GCM cipher, its IV, and the envelope header to write ahead of it.
   *
   * `scope_key` is a key in the directory the finished object belongs to, which for a staged
   * large-file upload is its content-addressed key rather than the staging key.
   */
  create_cipher(scope_key: string): { cipher: CipherGCM; iv: Buffer; header: Buffer };

  /**
   * Creates a streaming AES-256-GCM decipher for the given IV and auth tag.
   *
   * `header` is the envelope header found ahead of the IV, absent for an object written before the
   * binding existed.
   */
  create_decipher(iv: Buffer, auth_tag: Buffer, scope_key: string, header?: Buffer): DecipherGCM;
}

/** Bundles tenant-scoped storage and encryption for a single tenant. */
export interface TenantContext extends TenantStorageContext, TenantCryptoContext {
  /** Zeros sensitive key material. Call when the context is no longer needed. */
  destroy(): void;
}

/** Factory that initializes per-tenant infrastructure (bucket, DEK) on demand. */
export interface TenantContextFactory {
  create(tenant_id: string): Promise<TenantContext>;

  /**
   * Loads an existing tenant context without provisioning anything: no
   * CreateBucket, no DEK generation. Read-only paths (catalog listings, stats,
   * identity registry dumps) MUST use this so a mistyped tenant id cannot
   * leave a bucket and key material behind, and so read-only credentials need
   * neither `s3:CreateBucket` nor write access to `_meta/`.
   * Rejects when the tenant has no stored DEK.
   */
  create_readonly(tenant_id: string): Promise<TenantContext>;

  /**
   * Ensures the tenant bucket exists and returns raw storage only (no DEK load).
   * Use for operations that delete or list ciphertext by key without decrypting,
   * e.g. `atlas delete --purge` when `_meta/dek.enc` is missing or unreadable.
   */
  create_storage_only(tenant_id: string): Promise<TenantStorageContext>;
}
