import type { Camelize } from '@/public/case-convert';

/** What kind of stored object a quarantine moved aside. */
export type QuarantinedObjectKind = 'manifest' | 'version_index';

export interface QuarantineResult {
  /** The key the unreadable object was read from. Nothing is left at it afterwards. */
  readonly storage_key: string;
  /** Where the object's bytes now are, unchanged: `_quarantine/{storage_key}`. */
  readonly quarantine_key: string;
  readonly kind: QuarantinedObjectKind;
  /** Why the object could not be read, as the read reported it. */
  readonly reason: string;
}

/**
 * Moves one unreadable manifest or version index aside so listings, status and backups stop
 * reporting it (issue #631). The bytes are copied to `_quarantine/{key}` before the original is
 * removed, so nothing is destroyed, and an object that still reads cleanly is refused.
 */
export interface QuarantineUseCase {
  /**
   * @throws NotFoundError when no object exists at `storage_key`, or when it reads cleanly.
   * @throws ObjectLockRetainedError when retention refuses the removal; the copy is kept.
   */
  quarantine_unreadable_object(tenant_id: string, storage_key: string): Promise<QuarantineResult>;
}

/** `QuarantineResult` in the SDK's camelCase form. */
export type SdkQuarantineResult = Camelize<QuarantineResult>;
