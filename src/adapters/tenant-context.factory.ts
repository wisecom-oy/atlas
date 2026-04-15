import { inject, injectable } from 'inversify';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT_TOKEN } from '@/adapters/storage-s3/s3-client.factory';
import { S3ObjectStorage } from '@/adapters/storage-s3/s3-object-storage.adapter';
import { ensure_bucket_exists } from '@/adapters/storage-s3/s3-bucket-manager';
import { tenant_bucket_name } from '@/adapters/storage-s3/tenant-bucket-name';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import type {
  TenantContext,
  TenantContextFactory,
  TenantStorageContext,
} from '@/ports/tenant/context.port';
import type { AtlasConfig } from '@/utils/config';
import { ATLAS_CONFIG_TOKEN } from '@/utils/config';
import { logger } from '@/utils/logger';

const DEK_META_KEY = '_meta/dek.enc';

@injectable()
export class DefaultTenantContextFactory implements TenantContextFactory {
  constructor(
    @inject(S3_CLIENT_TOKEN) private readonly _s3: S3Client,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {}

  /** @inheritdoc */
  async create_storage_only(tenant_id: string): Promise<TenantStorageContext> {
    const bucket = tenant_bucket_name(tenant_id);
    await ensure_bucket_exists(this._s3, bucket);
    return {
      tenant_id,
      storage: new S3ObjectStorage(this._s3, bucket),
    };
  }

  /**
   * Initializes a tenant's infrastructure and returns a scoped context:
   *   1. Ensures the per-tenant bucket exists
   *   2. Loads or creates the tenant's data encryption key (DEK)
   *   3. Returns storage + encrypt/decrypt bound to that tenant
   */
  async create(tenant_id: string): Promise<TenantContext> {
    const { storage } = await this.create_storage_only(tenant_id);

    const key_service = new EnvelopeKeyService(this._config.encryption_passphrase);
    const dek = await this.load_or_create_dek(storage, key_service, tenant_id);

    return {
      tenant_id,
      storage,
      encrypt: (data: Buffer): Buffer => key_service.encrypt(data, dek),
      decrypt: (data: Buffer): Buffer => key_service.decrypt(data, dek),
      destroy: (): void => key_service.destroy(),
    };
  }

  /**
   * Loads an existing wrapped DEK from the tenant bucket, or generates
   * a new one and persists it. The DEK is always stored encrypted with
   * the tenant-specific KEK derived from the master passphrase.
   */
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

    logger.info(`Generating new encryption key for tenant ${tenant_id}`);
    const dek = key_service.generate_dek();
    const wrapped = key_service.wrap_dek(dek, tenant_id);
    await storage.put(DEK_META_KEY, wrapped);
    return dek;
  }
}
