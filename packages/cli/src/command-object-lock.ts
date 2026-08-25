import type {
  ObjectLockPolicy,
  ObjectLockRequest,
} from '@wisecom/atlas-types/ports/backup/use-case.port';
import {
  build_object_lock_policy as build_policy,
  build_object_lock_request as build_request,
} from '@wisecom/atlas-core/services/shared/object-lock-policy';

/** CLI flags shared by every command that accepts Object Lock options. */
export interface ObjectLockFlagOptions {
  retentionDays?: string;
  lockMode?: string;
}

/** Builds an ObjectLockRequest from CLI flags; undefined when no retention requested. */
export function build_object_lock_request(
  options: ObjectLockFlagOptions,
): ObjectLockRequest | undefined {
  return build_request({
    retention_days: parse_retention_days(options.retentionDays),
    lock_mode: options.lockMode,
  });
}

/** Builds an ObjectLockPolicy from CLI flags; undefined when no retention requested. */
export function build_object_lock_policy(
  options: ObjectLockFlagOptions,
): ObjectLockPolicy | undefined {
  return build_policy({
    retention_days: parse_retention_days(options.retentionDays),
    lock_mode: options.lockMode,
  });
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
