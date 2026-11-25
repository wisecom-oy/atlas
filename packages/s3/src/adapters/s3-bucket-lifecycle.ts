import { createHash } from 'node:crypto';
import {
  DeleteBucketLifecycleCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type S3Client,
  type TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';
import { logger } from '@wisecom/atlas-core';
import type { StorageLifecycleCheck } from '@wisecom/atlas-types';
import { is_access_denied } from '@/adapters/s3-error-classifier';
import {
  ATLAS_LIFECYCLE_RULES,
  BASE_LIFECYCLE_RULES,
  HOUSEKEEPING_RULE,
  NONCURRENT_VERSIONS_RULE,
  STATE_KEY_PREFIXES,
  find_misscoped_state_rules,
  stored_rule_prefix,
} from '@/adapters/s3-lifecycle-rules';

/** A bucket's lifecycle rules and the configuration-level setting a rewrite must carry over. */
export interface StoredLifecycle {
  readonly rules: readonly LifecycleRule[];
  readonly transition_default_minimum_object_size?: TransitionDefaultMinimumObjectSize | undefined;
}

/** Reads the bucket's lifecycle configuration. A bucket without one has no rules. */
export async function read_bucket_lifecycle(
  client: S3Client,
  bucket: string,
): Promise<StoredLifecycle> {
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    return {
      rules: response.Rules ?? [],
      transition_default_minimum_object_size: response.TransitionDefaultMinimumObjectSize,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchLifecycleConfiguration') return { rules: [] };
    throw err;
  }
}

/**
 * Replaces the bucket's whole lifecycle configuration. The request carries an explicit
 * Content-MD5: MinIO requires it on lifecycle puts and AWS SDK >= 3.729 no longer sends it.
 */
export async function put_bucket_lifecycle(
  client: S3Client,
  bucket: string,
  lifecycle: StoredLifecycle,
): Promise<void> {
  const size = lifecycle.transition_default_minimum_object_size;
  const command = new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: { Rules: [...lifecycle.rules] },
    ...(size !== undefined ? { TransitionDefaultMinimumObjectSize: size } : {}),
  });
  add_content_md5(command);
  await client.send(command);
}

/** Writes `lifecycle` back, or removes the configuration when it had no rules. */
export async function restore_bucket_lifecycle(
  client: S3Client,
  bucket: string,
  lifecycle: StoredLifecycle,
): Promise<void> {
  if (lifecycle.rules.length > 0) {
    await put_bucket_lifecycle(client, bucket, lifecycle);
    return;
  }
  await client.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
}

/**
 * Best-effort lifecycle rules for a bucket Atlas has just created: housekeeping, a 30-day
 * noncurrent window everywhere, and a one-day window under the state-key prefixes (issue #918).
 * A backend that refuses the full set, or stores a state rule without its prefix, gets the two
 * base rules instead, so a one-day window never reaches `_meta/dek.enc`. Failures are logged.
 */
export async function apply_default_lifecycle(client: S3Client, bucket: string): Promise<void> {
  try {
    await put_bucket_lifecycle(client, bucket, { rules: ATLAS_LIFECYCLE_RULES });
  } catch (err) {
    if (is_access_denied(err)) {
      warn_lifecycle_skipped(bucket, err);
      return;
    }
    logger.warn(
      `Bucket "${bucket}" refused the state-key lifecycle rules (${error_text(err)}); ` +
        `requesting the two base rules only`,
    );
    await put_base_lifecycle(client, bucket);
    return;
  }
  const misscoped = await find_misscoped_after_put(client, bucket);
  if (misscoped.length > 0) {
    logger.warn(
      `Bucket "${bucket}" stored ${misscoped.join(', ')} without its prefix; ` +
        `requesting the two base rules only`,
    );
    await put_base_lifecycle(client, bucket);
  }
}

async function put_base_lifecycle(client: S3Client, bucket: string): Promise<void> {
  try {
    await put_bucket_lifecycle(client, bucket, { rules: BASE_LIFECYCLE_RULES });
  } catch (err) {
    warn_lifecycle_skipped(bucket, err);
  }
}

/** State rules stored without their prefix. A backend that cannot read rules back yields none. */
async function find_misscoped_after_put(client: S3Client, bucket: string): Promise<string[]> {
  try {
    const stored = await read_bucket_lifecycle(client, bucket);
    return find_misscoped_state_rules(stored.rules);
  } catch {
    return [];
  }
}

function warn_lifecycle_skipped(bucket: string, err: unknown): void {
  logger.warn(
    `Could not configure lifecycle rules on bucket "${bucket}" (best-effort): ${error_text(err)}`,
  );
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
  let stored: StoredLifecycle;
  try {
    stored = await read_bucket_lifecycle(client, bucket);
  } catch (err) {
    return { status: 'not_checked', detail: describe_lifecycle_read_failure(err) };
  }
  return { status: 'checked', missing_actions: find_missing_actions(stored.rules) };
}

/** Why the lifecycle configuration could not be read, in terms an operator can act on. */
export function describe_lifecycle_read_failure(err: unknown): string {
  if (is_access_denied(err)) return 'access denied (requires s3:GetLifecycleConfiguration)';
  if (err instanceof Error && (err.name === 'NoSuchBucket' || err.name === 'NotFound')) {
    return 'the bucket does not exist';
  }
  if (err instanceof Error && err.name === 'NotImplemented') {
    return 'the backend does not support lifecycle readback';
  }
  return 'could not read the bucket lifecycle configuration';
}

type MissingAction = { rule_id: string; action: string };

function find_missing_actions(rules: readonly LifecycleRule[]): MissingAction[] {
  const enabled = (id: string): LifecycleRule | undefined =>
    rules.find((rule) => rule.ID === id && rule.Status === 'Enabled');
  const housekeeping = enabled(HOUSEKEEPING_RULE.ID);
  const noncurrent_versions = enabled(NONCURRENT_VERSIONS_RULE.ID);

  const missing_actions: MissingAction[] = [];
  if ((housekeeping?.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? 0) <= 0) {
    missing_actions.push({
      rule_id: HOUSEKEEPING_RULE.ID,
      action: 'AbortIncompleteMultipartUpload',
    });
  }
  if (housekeeping?.Expiration?.ExpiredObjectDeleteMarker !== true) {
    missing_actions.push({ rule_id: HOUSEKEEPING_RULE.ID, action: 'ExpiredObjectDeleteMarker' });
  }
  if (!has_noncurrent_expiration(noncurrent_versions)) {
    missing_actions.push({
      rule_id: NONCURRENT_VERSIONS_RULE.ID,
      action: 'NoncurrentVersionExpiration',
    });
  }
  for (const { rule_id, prefix } of STATE_KEY_PREFIXES) {
    const missing = find_missing_state_action(rule_id, prefix, enabled(rule_id));
    if (missing !== undefined) missing_actions.push(missing);
  }
  return missing_actions;
}

/**
 * A state rule needs its expiry and its own prefix. `Prefix` is reported when the stored rule
 * filters on anything else, because a wider filter would shorten the window for the whole bucket.
 */
function find_missing_state_action(
  rule_id: string,
  prefix: string,
  rule: LifecycleRule | undefined,
): MissingAction | undefined {
  if (!has_noncurrent_expiration(rule)) return { rule_id, action: 'NoncurrentVersionExpiration' };
  if (rule !== undefined && stored_rule_prefix(rule) !== prefix) {
    return { rule_id, action: 'Prefix' };
  }
  return undefined;
}

function has_noncurrent_expiration(rule: LifecycleRule | undefined): boolean {
  return (rule?.NoncurrentVersionExpiration?.NoncurrentDays ?? 0) > 0;
}

function error_text(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
