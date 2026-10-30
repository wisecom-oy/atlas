import { GetObjectLockConfigurationCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StorageDefaultRetention } from '@wisecom/atlas-types';

/**
 * Reads the bucket's default retention rule, or `undefined` when none is set.
 *
 * Call only on a bucket with Object Lock enabled: on any other bucket the backend answers with an
 * error rather than an empty configuration.
 */
export async function read_bucket_default_retention(
  client: S3Client,
  bucket: string,
): Promise<StorageDefaultRetention | undefined> {
  const response = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
  const rule = response.ObjectLockConfiguration?.Rule?.DefaultRetention;
  if (rule?.Mode !== 'GOVERNANCE' && rule?.Mode !== 'COMPLIANCE') return undefined;
  return {
    mode: rule.Mode,
    ...(rule.Days !== undefined ? { days: rule.Days } : {}),
    ...(rule.Years !== undefined ? { years: rule.Years } : {}),
  };
}
