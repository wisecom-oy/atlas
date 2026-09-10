import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import type { StorageTarget, StorageTargetConfig } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { ensure_bucket_exists } from '@/adapters/s3-bucket-manager';
import { BucketCache } from '@/adapters/bucket-cache';
import { tenant_bucket_name } from '@/adapters/tenant-bucket-name';
import { EnvelopeKeyService } from '@wisecom/atlas-core';

const DEK_META_KEY = '_meta/dek.enc';

function derive_target_id(endpoint: string, region?: string): string {
  const raw = `${endpoint}|${region ?? 'us-east-1'}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Creates a lightweight storage-only target for replication.
 *
 * Bound into the container by symbol, which is untyped, so this signature is the only thing
 * standing between a caller and an S3 client built from undefined credentials (issue #377).
 */
export function create_storage_target(config: StorageTargetConfig): StorageTarget {
  return new DefaultStorageTarget(config);
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
  /**
   * Its own cache, not the instance's: a replication target is a different
   * endpoint, and a same-named bucket there is a different bucket (issue #42).
   */
  private readonly _buckets = new BucketCache();

  constructor(config: StorageTargetConfig) {
    this.target_id = config.targetId ?? derive_target_id(config.s3Endpoint, config.s3Region);
    this.endpoint = config.s3Endpoint;
    this._passphrase = config.encryptionPassphrase;
    this._region = config.s3Region ?? 'us-east-1';

    this._client = new S3Client({
      endpoint: config.s3Endpoint,
      region: this._region,
      credentials: {
        accessKeyId: config.s3AccessKey,
        secretAccessKey: config.s3SecretKey,
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
    await ensure_bucket_exists(this._client, bucket, this._buckets, true);

    const storage = new S3ObjectStorage(this._client, bucket, this._buckets);
    const has_dek = await storage.exists(DEK_META_KEY);

    if (has_dek) {
      const key_service = new EnvelopeKeyService(this._passphrase);
      const dek = key_service.unwrap_dek(await storage.get(DEK_META_KEY), tenant_id);
      return {
        tenant_id,
        storage,
        encrypt: (data: Buffer, storage_key: string): Buffer =>
          key_service.encrypt(data, dek, storage_key),
        decrypt: (data: Buffer, storage_key: string): Buffer =>
          key_service.decrypt(data, dek, storage_key),
        create_cipher: (scope_key: string) => key_service.create_encrypt_cipher(dek, scope_key),
        create_decipher: (iv: Buffer, auth_tag: Buffer, scope_key: string, header?: Buffer) =>
          key_service.create_decrypt_decipher(dek, iv, auth_tag, scope_key, header),
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
