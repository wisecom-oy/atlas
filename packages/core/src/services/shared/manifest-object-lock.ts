import type {
  ManifestObjectLockEffectivePolicy,
  ManifestObjectLockPolicy,
  ObjectLockPolicy,
  ObjectLockRequest,
} from '@wisecom/atlas-types';
import { is_json_record } from '@/services/shared/stored-json-reader';

/**
 * Records the Object Lock retention a run asked for next to the one it applied, for its manifest.
 * Undefined when the run applied no policy, which is how a manifest says it was written unlocked.
 */
export function build_manifest_object_lock_policy(
  request: ObjectLockRequest | undefined,
  policy: ObjectLockPolicy | undefined,
): ManifestObjectLockPolicy | undefined {
  if (!policy) return undefined;
  return {
    requested: { mode: request?.mode, retention_days: request?.retention_days },
    effective: { mode: policy.mode, retain_until: policy.retain_until },
  };
}

/**
 * The applied policy a snapshot summary row carries for a manifest's `object_lock`. Undefined when
 * the manifest records none or its policy set no retain-until instant, which locks nothing.
 */
export function summarize_manifest_object_lock(
  object_lock: ManifestObjectLockPolicy | undefined,
): ManifestObjectLockEffectivePolicy | undefined {
  const effective = object_lock?.effective;
  return effective?.retain_until ? effective : undefined;
}

/** Reads a summary row's stored lock policy; undefined when absent, null when malformed. */
export function parse_stored_object_lock(
  value: unknown,
): ManifestObjectLockEffectivePolicy | undefined | null {
  if (value === undefined) return undefined;
  if (!is_json_record(value)) return null;
  const { mode, retain_until } = value;
  if (mode !== undefined && mode !== 'GOVERNANCE' && mode !== 'COMPLIANCE') return null;
  if (retain_until !== undefined && typeof retain_until !== 'string') return null;
  return { mode, retain_until };
}

/**
 * Returns a backup result carrying the policy its run applied, or `result` unchanged when the run
 * applied none, so a host reads the lock without a second call (#975).
 */
export function with_run_object_lock<T extends object>(
  result: T,
  object_lock: ManifestObjectLockPolicy | undefined,
): T {
  return object_lock === undefined ? result : { ...result, object_lock };
}
