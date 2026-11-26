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
 * One conditional-write rule a backend broke during the probe.
 *
 * - `create_only`: it accepted `If-None-Match: *` onto an existing key, which must be refused.
 * - `stale_if_match`: it accepted `If-Match` with an ETag the object no longer has, which must be
 *   refused.
 * - `current_if_match`: it refused `If-Match` with the ETag the object has, which must be
 *   accepted. Ceph RGW 18 does this, so every compare-and-swap fails there.
 */
export type ConditionalWriteViolation = 'create_only' | 'stale_if_match' | 'current_if_match';

/**
 * Whether the backend enforces the conditional writes Atlas depends on: it refuses a create-only
 * write onto an existing key and a compare-and-swap with a stale ETag, and accepts one with the
 * current ETag. `ignored` means it broke at least one of these, so the owner lease, the data key
 * bootstrap, create-only manifests and the identity registry cannot exclude concurrent writers on
 * this backend, and Atlas refuses to write there. `not_probed` means the probe could not run: no
 * bucket yet, no write access, or a storage failure.
 */
export interface StorageConditionalWriteCheck {
  readonly support: 'supported' | 'ignored' | 'not_probed';
  /** Which conditions were broken, or why the probe did not run. */
  readonly detail?: string | undefined;
  /** The rules the backend broke, in probe order. Present only when `support` is `ignored`. */
  readonly violations?: readonly ConditionalWriteViolation[] | undefined;
}

/** One Atlas lifecycle action the bucket's enabled rules lack. */
export interface StorageLifecycleMissingAction {
  readonly rule_id: string;
  readonly action: string;
  /**
   * True when `apply_lifecycle` restores it: the rule is absent, or it is a state-key rule. A
   * disabled or edited base rule is the operator's choice and is never overwritten.
   */
  readonly fixed_by_apply: boolean;
}

/** Which Atlas actions are missing from enabled bucket rules, or why they could not be checked. */
export type StorageLifecycleCheck =
  | {
      readonly status: 'checked';
      readonly missing_actions: readonly StorageLifecycleMissingAction[];
    }
  | { readonly status: 'not_checked'; readonly detail: string };

/** Outcome of adding the Atlas lifecycle rules a bucket lacked and resetting broken state rules. */
export type StorageLifecycleUpdate =
  | {
      readonly status: 'applied';
      readonly added_rule_ids: readonly string[];
      /** State-key rules that were disabled, lacked their expiry, or had another prefix. */
      readonly replaced_rule_ids: readonly string[];
    }
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
