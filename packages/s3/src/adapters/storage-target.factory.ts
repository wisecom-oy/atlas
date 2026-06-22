import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import type { StorageTarget, StorageTargetConfig } from '@atlas/types';
import type { TenantContext } from '@atlas/types';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { ensure_bucket_exists } from '@/adapters/s3-bucket-manager';
import { tenant_bucket_name } from '@/adapters/tenant-bucket-name';
import { EnvelopeKeyService } from '@atlas/core';

const DEK_META_KEY = '_meta/dek.enc';

/** SDK-facing camelCase config, consistent with AtlasInstanceConfig. */
export interface StorageTargetSdkConfig {
  readonly targetId?: string;
  readonly s3Endpoint: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;
  readonly s3Region?: string;
  readonly encryptionPassphrase: string;
}

function derive_target_id(endpoint: string, region?: string): string {
  const raw = `${endpoint}|${region ?? 'us-east-1'}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function normalize_target_config(
  config: StorageTargetSdkConfig | StorageTargetConfig,
): StorageTargetConfig {
  if ('s3_endpoint' in config) return config;
  let result: StorageTargetConfig = {
    s3_endpoint: config.s3Endpoint,
    s3_access_key: config.s3AccessKey,
    s3_secret_key: config.s3SecretKey,
    encryption_passphrase: config.encryptionPassphrase,
  };
  if (config.targetId !== undefined) {
    result = { ...result, target_id: config.targetId };
  }
  if (config.s3Region !== undefined) {
    result = { ...result, s3_region: config.s3Region };
  }
  return result;
}

/** Creates a lightweight storage-only target for replication. Accepts both camelCase (SDK) and snake_case (internal) config. */
export function create_storage_target(
  config: StorageTargetSdkConfig | StorageTargetConfig,
): StorageTarget {
  return new DefaultStorageTarget(normalize_target_config(config));
}

/**
 * A storage-only target that wraps its own S3Client.
 * Does NOT auto-generate a DEK -- the replication service is responsible
 * for copying dek.enc from the source before any encrypted operations.
 */
export class DefaultStorageTarget implements StorageTarget {
  readonly target_id: string;
  readonly endpoint: string;
  private readonly _client: S3Client;
  private readonly _passphrase: string;
  private readonly _region: string;

  constructor(config: StorageTargetConfig) {
    this.target_id = config.target_id ?? derive_target_id(config.s3_endpoint, config.s3_region);
    this.endpoint = config.s3_endpoint;
    this._passphrase = config.encryption_passphrase;
    this._region = config.s3_region ?? 'us-east-1';

    this._client = new S3Client({
      endpoint: config.s3_endpoint,
      region: this._region,
      credentials: {
        accessKeyId: config.s3_access_key,
        secretAccessKey: config.s3_secret_key,
      },
      forcePathStyle: true,
    });
  }

  /**
   * Creates a tenant context on this target.
   * If no DEK exists yet (fresh target), encrypt/decrypt will throw --
   * this is fine because replication copies raw ciphertext without decrypting.
   * After the replication service copies dek.enc, subsequent calls will work.
   */
  async create_context(tenant_id: string): Promise<TenantContext> {
    const bucket = tenant_bucket_name(tenant_id);
    await ensure_bucket_exists(this._client, bucket, true);

    const storage = new S3ObjectStorage(this._client, bucket);
    const has_dek = await storage.exists(DEK_META_KEY);

    if (has_dek) {
      const key_service = new EnvelopeKeyService(this._passphrase);
      const dek = key_service.unwrap_dek(await storage.get(DEK_META_KEY), tenant_id);
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

    const no_dek_msg = 'no DEK on target. Copy _meta/dek.enc first.';
    return {
      tenant_id,
      storage,
      encrypt: (): Buffer => {
        throw new Error(`Cannot encrypt: ${no_dek_msg}`);
      },
      decrypt: (): Buffer => {
        throw new Error(`Cannot decrypt: ${no_dek_msg}`);
      },
      create_cipher: (): ReturnType<EnvelopeKeyService['create_encrypt_cipher']> => {
        throw new Error(`Cannot create_cipher: ${no_dek_msg}`);
      },
      create_decipher: (): ReturnType<EnvelopeKeyService['create_decrypt_decipher']> => {
        throw new Error(`Cannot create_decipher: ${no_dek_msg}`);
      },
      destroy: (): void => {},
    };
  }
}
