import type { ManifestObjectLockEffectivePolicy, MailboxPurpose } from '@/domain/outlook/manifest';

/**
 * One snapshot as an owner's summary index records it: identity, time and totals, without the
 * entries. Listing an owner's snapshots reads these instead of decrypting every manifest (#625).
 */
export interface SnapshotSummary {
  readonly snapshot_id: string;
  readonly created_at: Date;
  /** Storage key of the manifest this row describes. */
  readonly manifest_key: string;
  /** Entries in this snapshot's own manifest, which holds one run's delta. */
  readonly entry_count: number;
  readonly total_size_bytes: number;
}

/** Characters in one hashed object ID in an Outlook summary row (96 bits, base64url). */
export const HASHED_OBJECT_ID_LENGTH = 16;

/** One folder's totals within a single snapshot's own entries. */
export interface SnapshotFolderTotals {
  readonly folder_id: string;
  readonly message_count: number;
  readonly total_size_bytes: number;
  readonly attachment_count: number;
  readonly attachment_size_bytes: number;
}

/**
 * The per-snapshot figures `stats` and `outlook list` sum, recorded beside the row's totals (#726).
 * Each is computed from one manifest, so a sum over rows equals the sum over manifests.
 */
export interface OutlookSnapshotAggregates {
  /** Entry sizes plus attachment sizes: the message bytes `stats` reports. */
  readonly entry_size_bytes: number;
  readonly attachment_count: number;
  readonly attachment_size_bytes: number;
  readonly folders: readonly SnapshotFolderTotals[];
  /**
   * Hashed IDs of the manifest's distinct entries, 16 characters each, concatenated. The merged
   * object count of a mailbox is computed from these, so the rows never carry message IDs.
   */
  readonly object_ids: string;
  /** Hashed IDs of the messages the snapshot's run recorded as removed, in the same encoding. */
  readonly removed_ids: string;
}

/** An Outlook snapshot as the mailbox's summary index records it. */
export interface OutlookSnapshotSummary extends SnapshotSummary {
  readonly owner_id: string;
  readonly owner_email?: string | undefined;
  readonly owner_display_name?: string | undefined;
  readonly mailbox_purpose?: MailboxPurpose | undefined;
  /** The manifest's `total_objects` high-water mark. */
  readonly total_objects: number;
  /** Message IDs the run recorded as removed. */
  readonly removed_count: number;
  /** The Object Lock retention the manifest was written with, when it had one. */
  readonly object_lock?: ManifestObjectLockEffectivePolicy | undefined;
  /** Absent on rows written before #726; readers then decrypt the manifest for these figures. */
  readonly aggregates?: OutlookSnapshotAggregates | undefined;
}

/** A OneDrive snapshot as the owner's summary index records it. */
export interface OneDriveSnapshotSummary extends SnapshotSummary {
  readonly owner_id: string;
  readonly owner_email?: string | undefined;
  readonly owner_display_name?: string | undefined;
  readonly total_files: number;
}

/** A SharePoint snapshot as the site's summary index records it. */
export interface SharePointSnapshotSummary extends SnapshotSummary {
  readonly site_id: string;
  readonly site_url?: string | undefined;
  readonly site_display_name?: string | undefined;
  readonly total_files: number;
}
