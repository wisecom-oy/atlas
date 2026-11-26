import type { ManifestObjectLockEffectivePolicy } from '@wisecom/atlas-types';

/**
 * Whether a snapshot's recorded Object Lock retention still runs at `now`, so the storage backend
 * would refuse to delete what that snapshot's run wrote. False when no retain-until is recorded,
 * which a manifest or summary row written without retention, or by a release before 7.3.0 for
 * OneDrive and SharePoint, leaves out.
 */
export function is_retention_in_force(
  effective: ManifestObjectLockEffectivePolicy | undefined,
  now: Date,
): boolean {
  if (effective?.retain_until === undefined) return false;
  const retain_until = new Date(effective.retain_until).getTime();
  return !Number.isNaN(retain_until) && retain_until > now.getTime();
}
