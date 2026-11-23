import { createHash } from 'node:crypto';
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type S3Client,
} from '@aws-sdk/client-s3';
import { logger } from '@wisecom/atlas-core';
import type { StorageLifecycleCheck } from '@wisecom/atlas-types';
import { is_access_denied } from '@/adapters/s3-error-classifier';

const housekeeping_rule = {
  ID: 'atlas-housekeeping',
  Status: 'Enabled',
  Filter: { Prefix: '' },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  Expiration: { ExpiredObjectDeleteMarker: true },
} satisfies LifecycleRule;

const noncurrent_versions_rule = {
  ID: 'atlas-expire-noncurrent-versions',
  Status: 'Enabled',
  Filter: { Prefix: '' },
  NoncurrentVersionExpiration: { NoncurrentDays: 30 },
} satisfies LifecycleRule;

/**
 * Best-effort housekeeping lifecycle rules for Atlas-created buckets:
 *  1. Abort incomplete multipart uploads after 7 days and remove delete
 *     markers that no longer reference any version (one combined rule:
 *     MinIO drops AbortIncompleteMultipartUpload and rejects a rule whose
 *     only action is that abort).
 *  2. Expire noncurrent versions after 30 days -- versioning is now on by
 *     default (Object Lock implies it), so overwritten cursors/indexes would
 *     otherwise accumulate stale versions forever. Atlas never reads
 *     noncurrent versions; its own version history is stored as first-class
 *     objects. Locked versions are simply retained until their lock expires.
 * The request carries an explicit Content-MD5: MinIO requires it on
 * lifecycle puts and AWS SDK >= 3.729 no longer sends it by default.
 * Failures are logged but not fatal.
 */
export async function apply_default_lifecycle(client: S3Client, bucket: string): Promise<void> {
  const command = new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [housekeeping_rule, noncurrent_versions_rule],
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

/**
 * Reads back Atlas lifecycle actions on an existing bucket. Some backends accept the lifecycle put
 * but omit individual actions from the configuration they store.
 */
export async function check_bucket_lifecycle(
  client: S3Client,
  bucket: string,
): Promise<StorageLifecycleCheck> {
  let rules: LifecycleRule[];
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    rules = response.Rules ?? [];
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchLifecycleConfiguration') {
      rules = [];
    } else {
      return { status: 'not_checked', detail: describe_lifecycle_read_failure(err) };
    }
  }

  return { status: 'checked', missing_actions: find_missing_actions(rules) };
}

function describe_lifecycle_read_failure(err: unknown): string {
  if (is_access_denied(err)) return 'access denied (requires s3:GetLifecycleConfiguration)';
  if (err instanceof Error && (err.name === 'NoSuchBucket' || err.name === 'NotFound')) {
    return 'the bucket does not exist';
  }
  if (err instanceof Error && err.name === 'NotImplemented') {
    return 'the backend does not support lifecycle readback';
  }
  return 'could not read the bucket lifecycle configuration';
}

function find_missing_actions(rules: LifecycleRule[]): { rule_id: string; action: string }[] {
  const housekeeping = rules.find(
    (rule) => rule.ID === housekeeping_rule.ID && rule.Status === 'Enabled',
  );
  const noncurrent_versions = rules.find(
    (rule) => rule.ID === noncurrent_versions_rule.ID && rule.Status === 'Enabled',
  );

  const missing_actions: { rule_id: string; action: string }[] = [];
  if ((housekeeping?.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? 0) <= 0) {
    missing_actions.push({
      rule_id: housekeeping_rule.ID,
      action: 'AbortIncompleteMultipartUpload',
    });
  }
  if (housekeeping?.Expiration?.ExpiredObjectDeleteMarker !== true) {
    missing_actions.push({ rule_id: housekeeping_rule.ID, action: 'ExpiredObjectDeleteMarker' });
  }
  if ((noncurrent_versions?.NoncurrentVersionExpiration?.NoncurrentDays ?? 0) <= 0) {
    missing_actions.push({
      rule_id: noncurrent_versions_rule.ID,
      action: 'NoncurrentVersionExpiration',
    });
  }
  return missing_actions;
}
