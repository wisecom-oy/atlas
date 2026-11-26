import { inject, injectable, optional } from 'inversify';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT_TOKEN } from '@/adapters/s3-client.factory';
import { check_bucket_lifecycle } from '@/adapters/s3-bucket-lifecycle';
import { add_missing_atlas_rules } from '@/adapters/s3-lifecycle-update';
import { probe_bucket_immutability } from '@/adapters/s3-bucket-manager';
import { read_bucket_default_retention } from '@/adapters/s3-default-retention';
import { S3ObjectStorage } from '@/adapters/s3-object-storage.adapter';
import { BucketCache } from '@/adapters/bucket-cache';
import { ConditionalWritePolicy, STORAGE_LEASE_POLICY } from '@/adapters/conditional-write-policy';
import { BUCKET_NAME_RESOLVER_TOKEN } from '@wisecom/atlas-types';
import type {
  BucketNameResolver,
  StorageCheckRequest,
  StorageCheckResult,
  StorageCheckUseCase,
} from '@wisecom/atlas-types';

@injectable()
export class StorageCheckService implements StorageCheckUseCase {
  constructor(
    @inject(S3_CLIENT_TOKEN) private readonly _s3: S3Client,
    @inject(BucketCache) private readonly _buckets: BucketCache,
    @inject(BUCKET_NAME_RESOLVER_TOKEN) private readonly _bucket_names: BucketNameResolver,
    @inject(ConditionalWritePolicy)
    @optional()
    private readonly _policy: ConditionalWritePolicy = STORAGE_LEASE_POLICY,
  ) {}

  /**
   * Checks bucket readiness for Object Lock policy before backup starts, and probes whether the
   * backend enforces the conditional writes the owner lease relies on (issues #623, #915). The probe
   * writes and deletes one object, so it needs write access to the bucket. With `apply_lifecycle`
   * it first adds the Atlas lifecycle rules the bucket lacks (issue #918), so the lifecycle check
   * reports the result. The probe always sends real conditions, so it reports the backend even in an
   * opt-in writer-exclusion mode, and the result names that mode (issue #974).
   */
  async check_storage(
    tenant_id: string,
    request: StorageCheckRequest = {},
  ): Promise<StorageCheckResult> {
    const bucket = this._bucket_names.resolve(tenant_id).name;
    const lifecycle_update = request.apply_lifecycle
      ? await add_missing_atlas_rules(this._s3, bucket)
      : undefined;
    const resolved_retain_until = request.retention_days
      ? compute_retain_until_utc(request.retention_days)
      : undefined;
    const probe = await probe_bucket_immutability(this._s3, bucket, this._buckets, {
      mode: request.mode,
      retain_until: resolved_retain_until,
    });
    const default_retention = probe.object_lock_enabled
      ? await read_bucket_default_retention(this._s3, bucket)
      : undefined;
    const lifecycle = await check_bucket_lifecycle(this._s3, bucket);
    const conditional_writes = await new S3ObjectStorage(
      this._s3,
      bucket,
      this._buckets,
    ).check_conditional_writes();

    return {
      bucket: probe.bucket,
      reachable: probe.reachable,
      versioning_enabled: probe.versioning_enabled,
      object_lock_enabled: probe.object_lock_enabled,
      mode_supported: probe.mode_supported,
      default_retention,
      conditional_writes,
      writer_exclusion: this._policy.mode,
      lifecycle,
      ...(lifecycle_update !== undefined ? { lifecycle_update } : {}),
      requested_mode: request.mode,
      requested_retention_days: request.retention_days,
      resolved_retain_until,
    };
  }
}

function compute_retain_until_utc(retention_days: number): string {
  const now = Date.now();
  const days_ms = retention_days * 24 * 60 * 60 * 1000;
  return new Date(now + days_ms).toISOString();
}
