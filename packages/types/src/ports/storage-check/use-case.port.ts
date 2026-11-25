import type { ObjectLockMode } from '@/ports/backup/use-case.port';

export interface StorageCheckRequest {
  readonly mode?: ObjectLockMode | undefined;
  readonly retention_days?: number | undefined;
  /**
   * Adds the Atlas lifecycle rules the bucket lacks before checking it, keeping every rule that is
   * already there. The only check option that changes the bucket configuration.
   */
  readonly apply_lifecycle?: boolean | undefined;
}

/** A bucket-wide default retention from the bucket's Object Lock configuration. */
export interface StorageDefaultRetention {
  readonly mode: ObjectLockMode;
  readonly days?: number | undefined;
  readonly years?: number | undefined;
}

/**
 * Whether the backend refuses a create-only write onto an existing key and a compare-and-swap
 * with a stale ETag. `ignored` means it accepted at least one of them, so the owner lease, the
 * data key bootstrap and the identity registry cannot exclude concurrent writers on this backend.
 * `not_probed` means the probe object could not be written: no bucket yet, or no write access.
 */
export interface StorageConditionalWriteCheck {
  readonly support: 'supported' | 'ignored' | 'not_probed';
  /** Which condition was ignored, or why the probe did not run. */
  readonly detail?: string | undefined;
}

/** Which Atlas actions are missing from enabled bucket rules, or why they could not be checked. */
export type StorageLifecycleCheck =
  | {
      readonly status: 'checked';
      readonly missing_actions: readonly { readonly rule_id: string; readonly action: string }[];
    }
  | { readonly status: 'not_checked'; readonly detail: string };

/** Outcome of adding the Atlas lifecycle rules a bucket lacked. */
export type StorageLifecycleUpdate =
  | { readonly status: 'applied'; readonly added_rule_ids: readonly string[] }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly detail: string };

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
  /** Result of the conditional-write probe, which writes and removes one throwaway object. */
  readonly conditional_writes: StorageConditionalWriteCheck;
  /** Read-only check of Atlas bucket lifecycle actions. */
  readonly lifecycle: StorageLifecycleCheck;
  /** Present when the request asked to apply the lifecycle rules. */
  readonly lifecycle_update?: StorageLifecycleUpdate | undefined;
  readonly requested_mode?: ObjectLockMode | undefined;
  readonly requested_retention_days?: number | undefined;
  readonly resolved_retain_until?: string | undefined;
}

export interface StorageCheckUseCase {
  check_storage(tenant_id: string, request?: StorageCheckRequest): Promise<StorageCheckResult>;
}
