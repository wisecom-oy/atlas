import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  type ObjectLockEnabled,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import type { BucketCache } from '@/adapters/bucket-cache';
import { invalid_bucket_name_error } from '@/adapters/tenant-bucket-name';
import { names_object_lock } from '@/adapters/s3-error-classifier';
import { apply_default_lifecycle } from '@/adapters/s3-bucket-lifecycle';

/**
 * Ensures a bucket exists, creating it if necessary.
 * New buckets are created lock-capable (`ObjectLockEnabledForBucket: true`,
 * which implies versioning): MinIO only allows that at creation time, and
 * AWS only later through a manual PutObjectLockConfiguration that Atlas
 * never sends. A lock-capable bucket without a retention config
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
): Promise<void> {
  if (cache.is_bucket_checked(bucket)) return;

  const exists = await bucket_exists(client, bucket).catch((err: unknown) => {
    throw invalid_bucket_name_error(bucket, err) ?? err;
  });
  if (!exists) {
    const invalid_name = invalid_bucket_name_error(bucket);
    if (invalid_name) throw invalid_name;
    await create_lock_capable_bucket(client, bucket);
    // Applied whether or not this run's CreateBucket won. The put is a full replace and
    // best-effort, and the other party may not be a concurrent run at all: an SDK retry of a
    // CreateBucket whose response was lost sees the same BucketAlreadyOwnedByYou, and then nobody
    // else is going to apply these rules.
    await apply_default_lifecycle(client, bucket);
  }

  cache.mark_bucket_checked(bucket);
}

/**
 * Creates a bucket with Object Lock enabled, falling back to a plain bucket
 * only when the backend rejects the capability itself. The fallback warning
 * matters because Atlas never enables Object Lock on an existing bucket, so
 * `--retention-days` then fails with `ObjectLockUnsupportedError`. MinIO
 * only enables the lock at creation; AWS accepts PutObjectLockConfiguration
 * on an existing versioned bucket, as a one-way manual step. See the
 * legacy-bucket section in docs/self-hosting/storage.md.
 */
async function create_lock_capable_bucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await create_unless_already_ours(client, bucket, true);
  } catch (err) {
    if (!is_lock_flag_rejection(err)) throw err;
    logger.warn(
      `Backend rejected Object Lock at creation for bucket "${bucket}" -- created without it. ` +
        `Immutability (--retention-days) will not work on this bucket.`,
    );
    await create_unless_already_ours(client, bucket, false);
  }
}

/**
 * Sends CreateBucket, accepting a bucket that already belongs to these
 * credentials. Two runs bootstrapping a new tenant at once both see the
 * bucket missing and both create it; the loser's `BucketAlreadyOwnedByYou`
 * means the bucket it wanted now exists. `BucketAlreadyExists` still throws:
 * that bucket belongs to another account, and writing tenant data beside it
 * must not be attempted. Backends that answer a same-owner re-create with
 * 200 (AWS us-east-1, Ceph RGW by default) never reach the catch.
 */
async function create_unless_already_ours(
  client: S3Client,
  bucket: string,
  object_lock: boolean,
): Promise<void> {
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(object_lock ? { ObjectLockEnabledForBucket: true } : {}),
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw err;
    logger.info(`Bucket "${bucket}" already exists under these credentials; using it`);
  }
}

/**
 * True when the backend cannot honour ObjectLockEnabledForBucket: NotImplemented, or a rejection
 * that names Object Lock. Any other failure (InvalidArgument, MalformedXML, AccessDenied) is
 * unrelated to the lock and must abort creation rather than yield an unlocked bucket (issue #640).
 */
function is_lock_flag_rejection(err: unknown): boolean {
  if (err instanceof Error && err.name === 'NotImplemented') return true;
  return names_object_lock(err);
}

/** Probes whether a bucket already exists and is accessible. */
export async function bucket_exists(client: S3Client, bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code === 'NotFound' || code === 'NoSuchBucket') return false;
    throw err;
  }
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
    throw invalid_bucket_name_error(bucket, err) ?? err;
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
