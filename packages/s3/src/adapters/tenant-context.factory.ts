import { inject, injectable } from 'inversify';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT_TOKEN } from '@/adapters/s3-client.factory';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';
import { ensure_bucket_exists } from '@/adapters/s3-bucket-manager';
import { tenant_bucket_name } from '@/adapters/tenant-bucket-name';
import { EnvelopeKeyService, ATLAS_CONFIG_TOKEN, logger } from '@wisecom/atlas-core';
import type { AtlasConfig } from '@wisecom/atlas-core';
import type {
  TenantContext,
  TenantContextFactory,
  TenantStorageContext,
} from '@wisecom/atlas-types';

const DEK_META_KEY = '_meta/dek.enc';

@injectable()
export class DefaultTenantContextFactory implements TenantContextFactory {
  constructor(
    @inject(S3_CLIENT_TOKEN) private readonly _s3: S3Client,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {}

  /** Ensures the tenant bucket exists and returns raw storage (no DEK). */
  async create_storage_only(tenant_id: string): Promise<TenantStorageContext> {
    const bucket = tenant_bucket_name(tenant_id);
    await ensure_bucket_exists(this._s3, bucket);
    return { tenant_id, storage: new S3ObjectStorage(this._s3, bucket) };
  }

  /** Initializes a tenant context with bucket, DEK, and crypto bindings. */
  async create(tenant_id: string): Promise<TenantContext> {
    const bucket = tenant_bucket_name(tenant_id);
    await ensure_bucket_exists(this._s3, bucket);
    const storage = new S3ObjectStorage(this._s3, bucket);

    const key_service = new EnvelopeKeyService(this._config.encryption_passphrase);
    const dek = await this.load_or_create_dek(storage, key_service, tenant_id);

    return build_context(tenant_id, storage, key_service, dek);
  }

  /**
   * Loads a tenant context without provisioning: the bucket is never created
   * and a missing DEK is never generated, so browsing an unknown tenant (a
   * mistyped `-t`) cannot leave a lifecycle-configured bucket and wrapped key
   * material behind, and read-only credentials need no `s3:CreateBucket` or
   * `_meta/` write permission (issue #93).
   */
  async create_readonly(tenant_id: string): Promise<TenantContext> {
    const storage = new S3ObjectStorage(this._s3, tenant_bucket_name(tenant_id));
    const key_service = new EnvelopeKeyService(this._config.encryption_passphrase);

    let wrapped: Buffer;
    try {
      wrapped = await storage.get(DEK_META_KEY);
    } catch (err) {
      key_service.destroy();
      if (is_absent(err)) throw new Error(`No backups found for tenant ${tenant_id}`);
      throw err;
    }

    return build_context(
      tenant_id,
      storage,
      key_service,
      key_service.unwrap_dek(wrapped, tenant_id),
    );
  }

  /** Loads an existing DEK or creates one with a race-safe conditional write. */
  private async load_or_create_dek(
    storage: S3ObjectStorage,
    key_service: EnvelopeKeyService,
    tenant_id: string,
  ): Promise<Buffer> {
    const dek_exists = await storage.exists(DEK_META_KEY);

    if (dek_exists) {
      const wrapped = await storage.get(DEK_META_KEY);
      return key_service.unwrap_dek(wrapped, tenant_id);
    }
    return this.create_dek_exclusively(storage, key_service, tenant_id);
  }

  /**
   * Persists a freshly generated DEK with a create-only conditional write
   * (If-None-Match: *). If a concurrent bootstrap wins the race, the write
   * fails with 412 and the winner's key is adopted. The key is then read
   * back and unwrapped so the DEK in use is always exactly what storage
   * holds - verified before any tenant data is encrypted with it. Unwrap
   * failure here is fatal by design: a DEK is never regenerated over an
   * existing one.
   */
  private async create_dek_exclusively(
    storage: S3ObjectStorage,
    key_service: EnvelopeKeyService,
    tenant_id: string,
  ): Promise<Buffer> {
    logger.info(`Generating new encryption key for tenant ${tenant_id}`);
    const dek = key_service.generate_dek();

    try {
      const wrapped = key_service.wrap_dek(dek, tenant_id);
      await storage.put(DEK_META_KEY, wrapped, undefined, undefined, undefined, true);
    } catch (err) {
      if (!(err instanceof PreconditionFailedError)) throw err;
      logger.warn(
        `Tenant ${tenant_id}: concurrent key bootstrap detected -- adopting the already stored key`,
      );
    }

    const stored = await storage.get(DEK_META_KEY);
    const stored_dek = key_service.unwrap_dek(stored, tenant_id);
    if (!stored_dek.equals(dek)) {
      logger.warn(
        `Tenant ${tenant_id}: stored key differs from the locally generated one -- using stored key`,
      );
    }
    return stored_dek;
  }
}

/** Binds storage and DEK-backed crypto operations into a tenant context. */
function build_context(
  tenant_id: string,
  storage: S3ObjectStorage,
  key_service: EnvelopeKeyService,
  dek: Buffer,
): TenantContext {
  return {
    tenant_id,
    storage,
    encrypt: (data: Buffer): Buffer => key_service.encrypt(data, dek),
    decrypt: (data: Buffer): Buffer => key_service.decrypt(data, dek),
    create_cipher: () => key_service.create_encrypt_cipher(dek),
    create_decipher: (iv: Buffer, auth_tag: Buffer) =>
      key_service.create_decrypt_decipher(dek, iv, auth_tag),
    destroy: (): void => key_service.destroy(),
  };
}

/** Returns whether a storage error means "no such object or bucket" rather than a real failure. */
function is_absent(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NoSuchBucket' || name === 'NotFound';
}
