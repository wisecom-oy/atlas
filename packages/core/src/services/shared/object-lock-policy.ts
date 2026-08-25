import type {
  ObjectLockMode,
  ObjectLockPolicy,
  ObjectLockRequest,
} from '@wisecom/atlas-types/ports/backup/use-case.port';

/**
 * Parsed Object Lock settings shared by every adapter (CLI flags, SDK options).
 * `retention_days` absent means no locking was requested.
 */
export interface ObjectLockSettings {
  retention_days?: number | undefined;
  lock_mode?: string | undefined;
  require_immutability?: boolean | undefined;
}

/** Builds an ObjectLockRequest; undefined when no retention was requested. */
export function build_object_lock_request(
  settings: ObjectLockSettings,
): ObjectLockRequest | undefined {
  if (!settings.retention_days) {
    return undefined;
  }
  return {
    mode: parse_object_lock_mode(settings.lock_mode, 'GOVERNANCE'),
    retention_days: settings.retention_days,
  };
}

/**
 * Builds an ObjectLockPolicy; undefined when no retention was requested.
 * `require_immutability` defaults to true so every adapter fails closed by default.
 */
export function build_object_lock_policy(
  settings: ObjectLockSettings,
): ObjectLockPolicy | undefined {
  if (!settings.retention_days) {
    return undefined;
  }
  return {
    mode: parse_object_lock_mode(settings.lock_mode, 'GOVERNANCE'),
    require_immutability: settings.require_immutability ?? true,
    retain_until: compute_retain_until_utc(settings.retention_days),
  };
}

/** Parses a lock mode string into an ObjectLockMode, falling back to default_mode. */
export function parse_object_lock_mode(
  raw_mode?: string,
  default_mode?: ObjectLockMode,
): ObjectLockMode | undefined {
  if (!raw_mode) return default_mode;
  const normalized = raw_mode.trim().toUpperCase();
  if (normalized === 'GOVERNANCE') return 'GOVERNANCE';
  if (normalized === 'COMPLIANCE') return 'COMPLIANCE';
  throw new Error(`Invalid object lock mode "${raw_mode}". Expected "governance" or "compliance".`);
}

/** Computes the retain-until timestamp (UTC ISO 8601) for a retention period in days. */
export function compute_retain_until_utc(retention_days: number): string {
  const now = Date.now();
  const days_ms = retention_days * 24 * 60 * 60 * 1000;
  return new Date(now + days_ms).toISOString();
}
