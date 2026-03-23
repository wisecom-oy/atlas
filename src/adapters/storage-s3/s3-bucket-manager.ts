import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  type ObjectLockEnabled,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
} from '@/ports/storage/object-storage.port';
import { logger } from '@/utils/logger';

const _checked_buckets = new Set<string>();
const _immutability_probe_cache = new Map<string, StorageImmutabilityProbeResult>();

/**
 * Ensures a bucket exists, creating it if necessary.
 * New buckets get best-effort housekeeping lifecycle rules (abort incomplete
 * multipart uploads, clean up expired delete markers). Existing buckets are
 * left untouched. Caches results in-process so subsequent calls are free.
 */
export async function ensure_bucket_exists(client: S3Client, bucket: string): Promise<void> {
  if (_checked_buckets.has(bucket)) return;

  const exists = await bucket_exists(client, bucket);
  if (!exists) {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await apply_default_lifecycle(client, bucket);
  }

  _checked_buckets.add(bucket);
}

/** Probes whether a bucket already exists and is accessible. */
async function bucket_exists(client: S3Client, bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code === 'NotFound' || code === 'NoSuchBucket') return false;
    throw err;
  }
}

/**
 * Best-effort housekeeping lifecycle rules for Atlas-created buckets:
 *  1. Abort incomplete multipart uploads after 7 days.
 *  2. Remove delete markers that no longer reference any version.
 * These are safe on both AWS S3 and MinIO. Failures are logged but not fatal.
 */
async function apply_default_lifecycle(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'atlas-abort-incomplete-uploads',
              Status: 'Enabled',
              Filter: {},
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            },
            {
              ID: 'atlas-cleanup-delete-markers',
              Status: 'Enabled',
              Filter: {},
              ExpiredObjectDeleteMarker: true,
            },
          ],
        },
      }),
    );
  } catch {
    logger.debug(`Could not configure lifecycle rules on bucket "${bucket}" (best-effort).`);
  }
}

/** Clears the in-process bucket cache (useful for testing). */
export function reset_bucket_cache(): void {
  _checked_buckets.clear();
  _immutability_probe_cache.clear();
}

/** Probes and memoizes immutability readiness for a bucket. */
export async function probe_bucket_immutability(
  client: S3Client,
  bucket: string,
  request: StorageImmutabilityProbeRequest = {},
): Promise<StorageImmutabilityProbeResult> {
  const cache_key = `${bucket}:${request.mode ?? 'NONE'}`;
  const cached = _immutability_probe_cache.get(cache_key);
  if (cached) return cached;

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (is_bucket_missing_error(err)) {
      const result: StorageImmutabilityProbeResult = {
        bucket,
        reachable: true,
        versioning_enabled: false,
        object_lock_enabled: false,
        mode_supported: false,
      };
      _immutability_probe_cache.set(cache_key, result);
      return result;
    }
    throw err;
  }

  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  const versioning_enabled = versioning.Status === 'Enabled';
  const object_lock_enabled = await detect_object_lock_enabled(client, bucket);

  const mode_supported = is_mode_supported(request.mode);
  const result: StorageImmutabilityProbeResult = {
    bucket,
    reachable: true,
    versioning_enabled,
    object_lock_enabled,
    mode_supported,
  };
  _immutability_probe_cache.set(cache_key, result);
  return result;
}

function is_mode_supported(mode?: string): boolean {
  if (!mode) return true;
  return mode === 'GOVERNANCE' || mode === 'COMPLIANCE';
}

function is_object_lock_enabled(value?: ObjectLockEnabled): boolean {
  return value === 'Enabled';
}

async function detect_object_lock_enabled(client: S3Client, bucket: string): Promise<boolean> {
  try {
    const object_lock = await client.send(
      new GetObjectLockConfigurationCommand({ Bucket: bucket }),
    );
    return is_object_lock_enabled(object_lock.ObjectLockConfiguration?.ObjectLockEnabled);
  } catch (err) {
    const message = err instanceof Error ? `${err.name} ${err.message}`.toLowerCase() : '';
    if (
      message.includes('nosuchobjectlockconfiguration') ||
      message.includes('object lock configuration does not exist') ||
      message.includes('objectlockconfigurationnotfounderror')
    ) {
      return false;
    }
    throw err;
  }
}

function is_bucket_missing_error(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}`.toLowerCase() : '';
  const status_code =
    typeof err === 'object' && err !== null && '$metadata' in err
      ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return (
    message.includes('nosuchbucket') ||
    message.includes('notfound') ||
    message.includes('bucket does not exist') ||
    status_code === 404
  );
}
