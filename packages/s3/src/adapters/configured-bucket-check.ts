import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigError } from '@wisecom/atlas-types';
import type { BucketCache } from '@/adapters/bucket-cache';
import { bucket_exists } from '@/adapters/s3-bucket-manager';

/**
 * Confirms a configured bucket exists, never creating it. A configured name is typed by an
 * operator, and creating a bucket under a typo would start a second tenant store with a fresh
 * data key beside the real one.
 *
 * @throws ConfigError when the bucket does not exist at the endpoint.
 */
export async function require_configured_bucket(
  client: S3Client,
  bucket: string,
  tenant_id: string,
  cache: BucketCache,
): Promise<void> {
  if (cache.is_bucket_checked(bucket)) return;
  if (!(await bucket_exists(client, bucket))) throw missing_configured_bucket(bucket, tenant_id);
  cache.mark_bucket_checked(bucket);
}

/** The error for a configured bucket that is not at the endpoint. */
export function missing_configured_bucket(bucket: string, tenant_id: string): ConfigError {
  return new ConfigError(
    `Bucket "${bucket}" is configured for tenant ${tenant_id} but does not exist at this ` +
      'endpoint. Atlas never creates a configured bucket: check the name, the endpoint and the ' +
      'region, or create the bucket first.',
  );
}
