import type { ObjectLockMode } from '@/ports/backup/use-case.port';

export interface StorageCheckRequest {
  readonly mode?: ObjectLockMode | undefined;
  readonly retention_days?: number | undefined;
}

/** A bucket-wide default retention from the bucket's Object Lock configuration. */
export interface StorageDefaultRetention {
  readonly mode: ObjectLockMode;
  readonly days?: number | undefined;
  readonly years?: number | undefined;
}

export interface StorageCheckResult {
  readonly bucket: string;
  readonly reachable: boolean;
  readonly versioning_enabled: boolean;
  readonly object_lock_enabled: boolean;
  readonly mode_supported: boolean;
  /**
   * The bucket's default retention, if one is set. Atlas never sets one since 6.1.0; a default
   * found here was left by an older version or set by hand, and it locks every write that carries
   * no retention of its own.
   */
  readonly default_retention?: StorageDefaultRetention | undefined;
  readonly requested_mode?: ObjectLockMode | undefined;
  readonly requested_retention_days?: number | undefined;
  readonly resolved_retain_until?: string | undefined;
}

export interface StorageCheckUseCase {
  check_storage(tenant_id: string, request?: StorageCheckRequest): Promise<StorageCheckResult>;
}
