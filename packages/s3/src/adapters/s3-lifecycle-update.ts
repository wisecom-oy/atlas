import type { S3Client } from '@aws-sdk/client-s3';
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
 * Adds the Atlas lifecycle rules an existing bucket lacks and resets broken state-key rules (issue
 * #918). The S3 put replaces the whole configuration, so the current one is read first and written
 * back with every other rule unchanged; nothing is written when the read fails. A state rule the
 * backend stores without its prefix would shorten the noncurrent window for the whole bucket, so
 * the previous configuration is restored when the read-back shows one, or cannot be done. The read
 * and the write are not atomic: an edit made by someone else between the two is lost.
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
  const { added_rule_ids, replaced_rule_ids } = merged;
  if (added_rule_ids.length === 0 && replaced_rule_ids.length === 0) {
    return { status: 'unchanged' };
  }

  try {
    await put_bucket_lifecycle(client, bucket, { ...current, rules: merged.rules });
  } catch (err) {
    return { status: 'failed', detail: describe_lifecycle_write_failure(err) };
  }
  const applied: StorageLifecycleUpdate = { status: 'applied', added_rule_ids, replaced_rule_ids };
  const written_ids = [...added_rule_ids, ...replaced_rule_ids];
  const problem = await find_scope_problem(client, bucket, written_ids);
  if (problem === undefined) return applied;
  return restore_previous_rules(client, bucket, current, problem);
}

/**
 * Why the rules just written cannot be trusted to keep their prefixes, or undefined when the
 * read-back shows they did. A failed read-back counts as a problem, not as success.
 */
async function find_scope_problem(
  client: S3Client,
  bucket: string,
  written_ids: readonly string[],
): Promise<string | undefined> {
  let stored: StoredLifecycle;
  try {
    stored = await read_bucket_lifecycle(client, bucket);
  } catch (err) {
    return `could not read the rules back to confirm their prefixes (${describe_lifecycle_read_failure(err)})`;
  }
  const misscoped = find_misscoped_state_rules(stored.rules).filter((id) =>
    written_ids.includes(id),
  );
  if (misscoped.length === 0) return undefined;
  return `the backend stored ${misscoped.join(', ')} without its prefix`;
}

/** Puts `previous` back after an unconfirmed write, and reports the update as failed. */
async function restore_previous_rules(
  client: S3Client,
  bucket: string,
  previous: StoredLifecycle,
  problem: string,
): Promise<StorageLifecycleUpdate> {
  try {
    await restore_bucket_lifecycle(client, bucket, previous);
  } catch (err) {
    return {
      status: 'failed',
      detail: `${problem}, and restoring the previous rules failed (${error_text(err)}); remove the atlas-state-versions-* rules by hand`,
    };
  }
  return { status: 'failed', detail: `${problem}; the previous rules were restored` };
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
