import type {
  ObjectLockMode,
  ObjectLockPolicy,
  ObjectLockRequest,
} from '@wisecom/atlas-types/ports/backup/use-case.port';

/** CLI flags shared by every command that accepts Object Lock options. */
export interface ObjectLockFlagOptions {
  retentionDays?: string;
  lockMode?: string;
  requireImmutability?: boolean;
}

/** Builds an ObjectLockRequest from CLI flags; undefined when no retention requested. */
export function build_object_lock_request(
  options: ObjectLockFlagOptions,
): ObjectLockRequest | undefined {
  const retention_days = parse_retention_days(options.retentionDays);
  const mode = parse_lock_mode(options.lockMode, retention_days ? 'GOVERNANCE' : undefined);
  if (!retention_days) {
    return undefined;
  }

  return {
    mode,
    retention_days,
  };
}

/** Builds an ObjectLockPolicy from CLI flags; undefined when no retention requested. */
export function build_object_lock_policy(
  options: ObjectLockFlagOptions,
): ObjectLockPolicy | undefined {
  const retention_days = parse_retention_days(options.retentionDays);
  const mode = parse_lock_mode(options.lockMode, retention_days ? 'GOVERNANCE' : undefined);
  const require_immutability = options.requireImmutability ?? true;
  if (!retention_days) {
    return undefined;
  }

  return {
    mode,
    require_immutability,
    retain_until: compute_retain_until_utc(retention_days),
  };
}

/** Parses --lock-mode into an ObjectLockMode, falling back to default_mode. */
export function parse_lock_mode(
  raw_mode?: string,
  default_mode?: ObjectLockMode,
): ObjectLockMode | undefined {
  if (!raw_mode) return default_mode;
  const normalized = raw_mode.trim().toUpperCase();
  if (normalized === 'GOVERNANCE') return 'GOVERNANCE';
  if (normalized === 'COMPLIANCE') return 'COMPLIANCE';
  throw new Error(
    `Invalid --lock-mode value "${raw_mode}". Expected "governance" or "compliance".`,
  );
}

/** Parses --retention-days into a positive integer. */
export function parse_retention_days(raw_days?: string): number | undefined {
  if (!raw_days) return undefined;
  const parsed = parseInt(raw_days, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --retention-days value "${raw_days}". Expected a positive integer.`);
  }
  return parsed;
}

function compute_retain_until_utc(retention_days: number): string {
  const now = Date.now();
  const days_ms = retention_days * 24 * 60 * 60 * 1000;
  return new Date(now + days_ms).toISOString();
}
