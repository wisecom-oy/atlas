import { inject, injectable } from 'inversify';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT_TOKEN } from '@/adapters/storage-s3/s3-client.factory';
import { probe_bucket_immutability } from '@/adapters/storage-s3/s3-bucket-manager';
import { tenant_bucket_name } from '@/adapters/storage-s3/tenant-bucket-name';
import type {
  StorageCheckRequest,
  StorageCheckResult,
  StorageCheckUseCase,
} from '@/ports/storage-check/use-case.port';

@injectable()
export class StorageCheckService implements StorageCheckUseCase {
  constructor(@inject(S3_CLIENT_TOKEN) private readonly _s3: S3Client) {}

  /** Checks bucket readiness for Object Lock policy before backup starts. */
  async check_storage(
    tenant_id: string,
    request: StorageCheckRequest = {},
  ): Promise<StorageCheckResult> {
    const bucket = tenant_bucket_name(tenant_id);
    const resolved_retain_until = request.retention_days
      ? compute_retain_until_utc(request.retention_days)
      : undefined;
    const probe = await probe_bucket_immutability(this._s3, bucket, {
      mode: request.mode,
      retain_until: resolved_retain_until,
    });

    return {
      bucket: probe.bucket,
      reachable: probe.reachable,
      versioning_enabled: probe.versioning_enabled,
      object_lock_enabled: probe.object_lock_enabled,
      mode_supported: probe.mode_supported,
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
