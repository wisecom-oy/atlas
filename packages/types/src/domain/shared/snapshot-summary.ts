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
