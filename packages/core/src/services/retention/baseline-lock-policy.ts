import type { ManifestObjectLockPolicy, StorageObjectLockPolicy } from '@wisecom/atlas-types';

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
  if (effective?.retain_until === undefined) return undefined;
  const retain_until = new Date(effective.retain_until);
  if (Number.isNaN(retain_until.getTime()) || retain_until <= now) return undefined;
  return { mode: effective.mode, retain_until: effective.retain_until };
}
