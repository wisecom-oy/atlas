import { createHash } from 'node:crypto';
import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectLockConfigurationCommand,
  type ObjectLockEnabled,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectLockMode,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { ObjectLockUnsupportedError } from '@/adapters/object-lock.errors';
import type { BucketCache } from '@/adapters/bucket-cache';

/**
 * Ensures a bucket exists, creating it if necessary.
 * New buckets are created lock-capable (`ObjectLockEnabledForBucket: true`,
 * which implies versioning): on AWS and MinIO this is only possible at
 * creation time, and a lock-capable bucket without a retention config
 * behaves exactly like a normal versioned bucket -- it merely keeps the
 * immutability door open (issue #30). Backends that reject the flag get a
 * plain bucket with a loud warning. New buckets also get best-effort
 * housekeeping lifecycle rules. Existing buckets are left untouched.
 * Caches results in-process so subsequent calls are free.
 */
export async function ensure_bucket_exists(
  client: S3Client,
  bucket: string,
  cache: BucketCache,
  skip_cache = false,
): Promise<void> {
  if (!skip_cache && cache.is_bucket_checked(bucket)) return;

  const exists = await bucket_exists(client, bucket);
  if (!exists) {
    await create_lock_capable_bucket(client, bucket);
    await apply_default_lifecycle(client, bucket);
  }

  cache.mark_bucket_checked(bucket);
}

/**
 * Creates a bucket with Object Lock enabled, falling back to a plain bucket
 * only when the backend rejects the capability itself. The fallback warning
 * matters: a plain bucket can never gain Object Lock later (AWS requires a
 * support ticket, MinIO refuses outright) -- see the legacy-bucket migration
 * runbook in docs/self-hosting/storage.md.
 */
async function create_lock_capable_bucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(
      new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }),
    );
  } catch (err) {
    if (!is_lock_flag_rejection(err)) throw err;
    logger.warn(
      `Backend rejected Object Lock at creation for bucket "${bucket}" -- created without it. ` +
        `Immutability (--retention-days) will not work on this bucket.`,
    );
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

/** True when the error signals the backend cannot honour ObjectLockEnabledForBucket. */
function is_lock_flag_rejection(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? '';
  // ponytail: name list covers AWS-compatible backends seen in the wild;
  // extend if a new backend rejects the flag with a different code.
  return ['NotImplemented', 'InvalidArgument', 'InvalidRequest', 'MalformedXML'].includes(name);
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
 *  1. Abort incomplete multipart uploads after 7 days and remove delete
 *     markers that no longer reference any version (one combined rule:
 *     MinIO rejects a rule whose only action is
 *     AbortIncompleteMultipartUpload -- verified against a live MinIO).
 *  2. Expire noncurrent versions after 30 days -- versioning is now on by
 *     default (Object Lock implies it), so overwritten cursors/indexes would
 *     otherwise accumulate stale versions forever. Atlas never reads
 *     noncurrent versions; its own version history is stored as first-class
 *     objects. Locked versions are simply retained until their lock expires.
 * The request carries an explicit Content-MD5: MinIO requires it on
 * lifecycle puts and AWS SDK >= 3.729 no longer sends it by default.
 * Failures are logged but not fatal.
 */
async function apply_default_lifecycle(client: S3Client, bucket: string): Promise<void> {
  const command = new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'atlas-housekeeping',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          Expiration: { ExpiredObjectDeleteMarker: true },
        },
        {
          ID: 'atlas-expire-noncurrent-versions',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        },
      ],
    },
  });
  add_content_md5(command);

  try {
    await client.send(command);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not configure lifecycle rules on bucket "${bucket}" (best-effort): ${msg}`);
  }
}

/** Injects a Content-MD5 header computed over the serialized request body. */
function add_content_md5(command: PutBucketLifecycleConfigurationCommand): void {
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = (args as { request: { body: string; headers: Record<string, string> } })
        .request;
      request.headers['content-md5'] = createHash('md5').update(request.body).digest('base64');
      return next(args);
    },
    { step: 'build', name: 'atlasContentMd5' },
  );
}

/** Probes and memoizes immutability readiness for a bucket. */
export async function probe_bucket_immutability(
  client: S3Client,
  bucket: string,
  cache: BucketCache,
  request: StorageImmutabilityProbeRequest = {},
): Promise<StorageImmutabilityProbeResult> {
  const cached = cache.get_immutability_probe(bucket, request.mode);
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
      cache.set_immutability_probe(bucket, request.mode, result);
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
  cache.set_immutability_probe(bucket, request.mode, result);
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

/**
 * Sets the bucket's Object Lock default retention so every new object version
 * inherits the lock - immutability as a bucket property that no write path
 * can forget. Requires a lock-capable bucket; throws
 * ObjectLockUnsupportedError when the bucket was created without Object Lock
 * (see the migration runbook in docs/self-hosting/storage.md).
 */
export async function apply_bucket_default_retention(
  client: S3Client,
  bucket: string,
  mode: StorageObjectLockMode,
  retention_days: number,
): Promise<void> {
  try {
    await client.send(
      new PutObjectLockConfigurationCommand({
        Bucket: bucket,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: mode, Days: retention_days } },
        },
      }),
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'InvalidBucketState' || name === 'ObjectLockConfigurationNotFoundError') {
      throw new ObjectLockUnsupportedError(bucket);
    }
    throw err;
  }
}
