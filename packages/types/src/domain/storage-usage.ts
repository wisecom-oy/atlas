/**
 * Physical storage usage of a tenant bucket, measured by listing it.
 *
 * Logical sizes (`total_size_bytes` on the statistics types) describe the backed-up items. These
 * describe what the bucket holds: encrypted, deduplicated objects, every retained version, and
 * the parts of uploads that never completed.
 */

/**
 * Where an object sits in the bucket layout. `meta` is the shared `_meta/` prefix; `other` is any
 * key outside the documented layout.
 */
export type StorageUsageWorkload = 'outlook' | 'onedrive' | 'sharepoint' | 'meta' | 'other';

/** Workloads whose manifests reference logical bytes. */
export type LogicalWorkload = 'outlook' | 'onedrive' | 'sharepoint';

export type StorageUsageBreakdown = 'workload' | 'owner';

export interface ObjectTally {
  readonly objects: number;
  readonly bytes: number;
}

export interface StorageUsageTotals {
  /** Latest version of each live object. */
  readonly current: ObjectTally;
  /** Older versions, kept by versioning or Object Lock retention. */
  readonly noncurrent: ObjectTally;
  /** Delete markers. They hold no bytes. */
  readonly delete_markers: number;
  /** Objects under the drive `staging/` prefixes. Already counted in `current` or `noncurrent`. */
  readonly staging: ObjectTally;
  /** Multipart uploads that were never completed or aborted, and the bytes their parts hold. */
  readonly incomplete_uploads: ObjectTally;
}

export interface StorageOwnerUsage {
  readonly workload: StorageUsageWorkload;
  /** Mailbox, OneDrive owner or SharePoint site id from the key; empty for keys without one. */
  readonly owner_id: string;
  readonly totals: StorageUsageTotals;
}

export interface StorageUsage {
  /** `primary`, or the `target_id` of the storage target that was measured. */
  readonly target: string;
  /** When the first call of this measurement started. */
  readonly started_at: string;
  /** When this call finished. */
  readonly measured_at: string;
  /** False when the run stopped early; pass `continuation_token` to resume. */
  readonly complete: boolean;
  readonly continuation_token?: string;
  /** False when the credentials could not list versions, so only current objects were counted. */
  readonly versions_visible: boolean;
  /** False when the credentials could not list multipart uploads. */
  readonly incomplete_uploads_visible: boolean;
  /** S3 requests made by this measurement so far, across resumed calls. */
  readonly list_requests: number;
  /** Bytes the backend holds: current, noncurrent and incomplete upload parts. */
  readonly stored_bytes: number;
  readonly totals: StorageUsageTotals;
  /** Per workload; the categories sum to `totals`. */
  readonly by_workload: Partial<Record<StorageUsageWorkload, StorageUsageTotals>>;
  /** Per owner or site, when the `owner` breakdown was requested. */
  readonly by_owner?: readonly StorageOwnerUsage[];
  /**
   * Logical bytes referenced by every stored manifest, the same totals `stats` reports. Present on
   * a complete measurement whose manifests could be read.
   */
  readonly logical_bytes_referenced?: number;
  readonly logical_bytes_by_workload?: Readonly<Record<LogicalWorkload, number>>;
}
