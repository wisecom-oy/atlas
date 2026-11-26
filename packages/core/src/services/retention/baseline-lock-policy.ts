import type { ManifestObjectLockPolicy, StorageObjectLockPolicy } from '@wisecom/atlas-types';
import { is_retention_in_force } from '@/services/retention/object-lock-retention';

/**
 * The Object Lock retention a baseline written over a kept snapshot's manifest carries: the
 * retention that snapshot's run applied, while it still runs. The baseline then stays protected
 * exactly as long as the manifest it replaces. A retention that has ended is not renewed, since
 * S3 refuses a retain-until date in the past; the bucket's default retention, if any, applies.
 */
export function baseline_lock_policy(
  object_lock: ManifestObjectLockPolicy | undefined,
  now: Date = new Date(),
): StorageObjectLockPolicy | undefined {
  const effective = object_lock?.effective;
  if (effective?.retain_until === undefined || !is_retention_in_force(effective, now)) {
    return undefined;
  }
  return { mode: effective.mode, retain_until: effective.retain_until };
}
