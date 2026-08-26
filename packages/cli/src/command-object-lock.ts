import type {
  ObjectLockPolicy,
  ObjectLockRequest,
} from '@wisecom/atlas-types/ports/backup/use-case.port';
import type { ObjectLockSettings } from '@wisecom/atlas-core/services/shared/object-lock-policy';
import {
  build_object_lock_policy as build_policy,
  build_object_lock_request as build_request,
  parse_object_lock_mode,
} from '@wisecom/atlas-core/services/shared/object-lock-policy';

/** CLI flags shared by every command that accepts Object Lock options. */
export interface ObjectLockFlagOptions {
  retentionDays?: string;
  lockMode?: string;
}

/**
 * Parses and validates the Object Lock flag pair.
 *
 * The core builders return early when no retention was requested, so they never see an invalid
 * mode and never notice a mode that cannot be applied. Both checks therefore belong here, at the
 * flag boundary: an operator who passes `--lock-mode` alone believes the backup is immutable, and
 * silently dropping the flag hands them an unprotected snapshot with a zero exit code (#186).
 */
function parse_object_lock_flags(options: ObjectLockFlagOptions): ObjectLockSettings {
  parse_object_lock_mode(options.lockMode);
  const retention_days = parse_retention_days(options.retentionDays);
  if (options.lockMode && retention_days === undefined) {
    throw new Error(
      '--lock-mode requires --retention-days. Object Lock mode alone applies no retention.',
    );
  }
  return { retention_days, lock_mode: options.lockMode };
}

/** Builds an ObjectLockRequest from CLI flags; undefined when no retention requested. */
export function build_object_lock_request(
  options: ObjectLockFlagOptions,
): ObjectLockRequest | undefined {
  return build_request(parse_object_lock_flags(options));
}

/** Builds an ObjectLockPolicy from CLI flags; undefined when no retention requested. */
export function build_object_lock_policy(
  options: ObjectLockFlagOptions,
): ObjectLockPolicy | undefined {
  return build_policy(parse_object_lock_flags(options));
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
