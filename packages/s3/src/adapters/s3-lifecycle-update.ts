import type { S3Client } from '@aws-sdk/client-s3';
import { logger } from '@wisecom/atlas-core';
import type { StorageLifecycleUpdate } from '@wisecom/atlas-types';
import {
  describe_lifecycle_read_failure,
  put_bucket_lifecycle,
  read_bucket_lifecycle,
  restore_bucket_lifecycle,
  type StoredLifecycle,
} from '@/adapters/s3-bucket-lifecycle';
import { is_access_denied } from '@/adapters/s3-error-classifier';
import { find_misscoped_state_rules, merge_atlas_rules } from '@/adapters/s3-lifecycle-rules';

/**
 * Adds the Atlas lifecycle rules an existing bucket lacks (issue #918). The S3 put replaces the
 * whole configuration, so the current one is read first and written back with every rule it had,
 * unchanged; nothing is written when the read fails. A rule added here that the backend stores
 * without its prefix would shorten the noncurrent window for the whole bucket, so the previous
 * configuration is then restored. The read and the write are not atomic: an edit made by someone
 * else between the two is lost.
 */
export async function add_missing_atlas_rules(
  client: S3Client,
  bucket: string,
): Promise<StorageLifecycleUpdate> {
  let current: StoredLifecycle;
  try {
    current = await read_bucket_lifecycle(client, bucket);
  } catch (err) {
    return { status: 'failed', detail: describe_lifecycle_read_failure(err) };
  }

  const merged = merge_atlas_rules(current.rules);
  if (merged.added_rule_ids.length === 0) return { status: 'unchanged' };

  try {
    await put_bucket_lifecycle(client, bucket, { ...current, rules: merged.rules });
  } catch (err) {
    return { status: 'failed', detail: describe_lifecycle_write_failure(err) };
  }
  return verify_added_rules(client, bucket, current, merged.added_rule_ids);
}

/** Reads the rules back and undoes the change when an added state rule lost its prefix. */
async function verify_added_rules(
  client: S3Client,
  bucket: string,
  previous: StoredLifecycle,
  added_rule_ids: readonly string[],
): Promise<StorageLifecycleUpdate> {
  let stored: StoredLifecycle;
  try {
    stored = await read_bucket_lifecycle(client, bucket);
  } catch (err) {
    logger.warn(
      `Added lifecycle rules to bucket "${bucket}" but could not read them back to confirm ` +
        `their prefixes: ${describe_lifecycle_read_failure(err)}`,
    );
    return { status: 'applied', added_rule_ids };
  }

  const misscoped = find_misscoped_state_rules(stored.rules).filter((id) =>
    added_rule_ids.includes(id),
  );
  if (misscoped.length === 0) return { status: 'applied', added_rule_ids };

  const dropped = `the backend stored ${misscoped.join(', ')} without its prefix`;
  try {
    await restore_bucket_lifecycle(client, bucket, previous);
  } catch (err) {
    return {
      status: 'failed',
      detail: `${dropped}, and restoring the previous rules failed (${error_text(err)}); remove those rules by hand`,
    };
  }
  return { status: 'failed', detail: `${dropped}; the previous rules were restored` };
}

function describe_lifecycle_write_failure(err: unknown): string {
  if (is_access_denied(err)) return 'access denied (requires s3:PutLifecycleConfiguration)';
  if (err instanceof Error && err.name === 'NotImplemented') {
    return 'the backend does not support lifecycle configuration';
  }
  return `the backend refused the lifecycle configuration (${error_text(err)})`;
}

function error_text(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
