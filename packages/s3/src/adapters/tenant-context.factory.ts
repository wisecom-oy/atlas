import { inject, injectable, optional } from 'inversify';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT_TOKEN } from '@/adapters/s3-client.factory';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { STORAGE_LEASE_POLICY, ConditionalWritePolicy } from '@/adapters/conditional-write-policy';
import {
  DEK_META_KEY,
  create_dek_exclusively,
  load_stored_dek,
} from '@/adapters/tenant-dek-bootstrap';
import { run_with_owner_lease } from '@wisecom/atlas-core/services/lease/run-with-owner-lease';
import { bucket_exists, ensure_bucket_exists } from '@/adapters/s3-bucket-manager';
import { BucketCache } from '@/adapters/bucket-cache';
import {
  missing_configured_bucket,
  require_configured_bucket,
} from '@/adapters/configured-bucket-check';
import { EnvelopeKeyService, ATLAS_CONFIG_TOKEN } from '@wisecom/atlas-core';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import type { AtlasConfig } from '@wisecom/atlas-core';
import { BUCKET_NAME_RESOLVER_TOKEN, NotFoundError, OWNER_LEASE_TOKEN } from '@wisecom/atlas-types';
import type {
  BucketNameResolver,
  OwnerLeasePort,
  ResolvedBucket,
  TenantContext,
  TenantContextFactory,
  TenantStorageContext,
} from '@wisecom/atlas-types';

@injectable()
export class DefaultTenantContextFactory implements TenantContextFactory {
  constructor(
    @inject(S3_CLIENT_TOKEN) private readonly _s3: S3Client,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
    @inject(BucketCache) private readonly _buckets: BucketCache,
    @inject(BUCKET_NAME_RESOLVER_TOKEN) private readonly _bucket_names: BucketNameResolver,
    @inject(ConditionalWritePolicy)
    @optional()
    private readonly _policy: ConditionalWritePolicy = STORAGE_LEASE_POLICY,
    @inject(OWNER_LEASE_TOKEN) @optional() private readonly _leases?: OwnerLeasePort,
  ) {}

  /**
   * Opens the tenant bucket as raw storage (no DEK) without creating it. Its callers delete,
   * list, or re-wrap what is already stored, so a missing bucket means there is nothing to act
   * on, and creating one would leave a bucket behind for a mistyped tenant (issue #601).
   */
  async create_storage_only(tenant_id: string): Promise<TenantStorageContext> {
    const bucket = this._bucket_names.resolve(tenant_id);
    const name = bucket.name;
    if (!this._buckets.is_bucket_checked(name) && !(await bucket_exists(this._s3, name))) {
      if (bucket.configured) throw missing_configured_bucket(name, tenant_id);
      throw new NotFoundError(`No backups found for tenant ${tenant_id}`);
    }
    return { tenant_id, storage: new S3ObjectStorage(this._s3, name, this._buckets, this._policy) };
  }

  /**
   * Initializes a tenant context with bucket, DEK, and crypto bindings. A derived bucket is
   * created when missing; a configured one never is.
   */
  async create(tenant_id: string): Promise<TenantContext> {
    const resolved = this._bucket_names.resolve(tenant_id);
    const bucket = resolved.name;
    if (resolved.configured) {
      await require_configured_bucket(this._s3, bucket, tenant_id, this._buckets);
    } else {
      await ensure_bucket_exists(this._s3, bucket, this._buckets);
    }
    const storage = new S3ObjectStorage(this._s3, bucket, this._buckets, this._policy);

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
    const bucket = this._bucket_names.resolve(tenant_id);
    const storage = new S3ObjectStorage(this._s3, bucket.name, this._buckets, this._policy);
    const key_service = new EnvelopeKeyService(this._config.encryption_passphrase);

    let wrapped: Buffer;
    try {
      wrapped = await storage.get(DEK_META_KEY);
    } catch (err) {
      key_service.destroy();
      if (is_absent_object_error(err)) throw await this.describe_absent_key(bucket, tenant_id, err);
      throw err;
    }

    return build_context(
      tenant_id,
      storage,
      key_service,
      await key_service.unwrap_dek(wrapped, tenant_id),
    );
  }

  /**
   * Explains a missing `_meta/dek.enc`. For a configured bucket a missing bucket is a
   * configuration error, not an empty tenant, so it costs one HeadBucket to tell them apart.
   */
  private async describe_absent_key(
    bucket: ResolvedBucket,
    tenant_id: string,
    cause: unknown,
  ): Promise<Error> {
    if (bucket.configured && !(await bucket_exists(this._s3, bucket.name))) {
      return missing_configured_bucket(bucket.name, tenant_id);
    }
    return new NotFoundError(`No backups found for tenant ${tenant_id}`, { cause });
  }

  /**
   * Loads an existing DEK or creates one with a race-safe create-only write. In an opt-in
   * writer-exclusion mode the creation also holds the tenant scope (issue #974): with no conditional
   * write at the backend, two processes creating the first key of one tenant would otherwise each
   * encrypt with their own, and the one overwritten could never be read again.
   */
  private async load_or_create_dek(
    storage: S3ObjectStorage,
    key_service: EnvelopeKeyService,
    tenant_id: string,
  ): Promise<Buffer> {
    if (await storage.exists(DEK_META_KEY)) {
      return load_stored_dek(storage, key_service, tenant_id);
    }
    if (!this._policy.emulates_conditions()) {
      return create_dek_exclusively(storage, key_service, tenant_id);
    }
    return this.create_dek_under_tenant_scope(storage, key_service, tenant_id);
  }

  /**
   * Creates the DEK while holding the tenant scope of the owner exclusion. Bootstraps in this
   * process queue instead of refusing each other, and each one that waited first looks again for
   * the key the one before it stored.
   *
   * @throws OwnerBusyError when another process holds the tenant or an owner scope.
   */
  private async create_dek_under_tenant_scope(
    storage: S3ObjectStorage,
    key_service: EnvelopeKeyService,
    tenant_id: string,
  ): Promise<Buffer> {
    const leases = this.require_leases();
    return this._policy.key_serializer.run(`#dek-bootstrap/${tenant_id}`, async () => {
      if (await storage.exists(DEK_META_KEY)) {
        return load_stored_dek(storage, key_service, tenant_id);
      }
      return run_with_owner_lease(
        leases,
        { tenant_id, storage },
        { workload: 'tenant', owner_id: tenant_id, operation: 'bootstrap' },
        () => create_dek_exclusively(storage, key_service, tenant_id),
      );
    });
  }

  private require_leases(): OwnerLeasePort {
    if (this._leases === undefined) {
      throw new Error('An owner exclusion must be bound to create a data key in this mode');
    }
    return this._leases;
  }
}

/** Binds storage and DEK-backed crypto operations into a tenant context. */
export function build_context(
  tenant_id: string,
  storage: S3ObjectStorage,
  key_service: EnvelopeKeyService,
  dek: Buffer,
): TenantContext {
  let naming_key: Buffer | undefined = key_service.derive_naming_key(dek);
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
    create_content_hmac: () => {
      if (!naming_key) throw new Error('Cannot name content: the tenant context was destroyed');
      return key_service.create_content_hmac(naming_key);
    },
    destroy: (): void => {
      key_service.destroy();
      naming_key?.fill(0);
      naming_key = undefined;
    },
  };
}
