/** Restore options shared by OneDrive and SharePoint for an item's sharing state. */
export interface DriveSharingRestoreOptions {
  /**
   * Reapply each item's captured direct grants and recreate its sharing links. Off by default:
   * restoring into another user's drive or an alternate location must not silently re-share
   * content with the original audience.
   */
  readonly restore_permissions?: boolean;
}

/** One permission a restore left out, and why. Never a failure of the run. */
export interface DriveRestoreSkippedItem {
  /** Path of the item in the snapshot. */
  readonly path: string;
  readonly kind: 'permission';
  /** What was skipped, such as `grant read to user@example.com` or `link edit/organization`. */
  readonly detail?: string;
  readonly reason: string;
}

/**
 * What a restore did with permissions. Reported apart from `errors`: a grantee deleted since the
 * backup, or a tenant that no longer allows anonymous links, is an expected outcome and must not
 * make the run exit partial.
 */
export interface DriveSharingRestoreSummary {
  /** Grants and links reapplied. */
  readonly permissions_applied?: number | undefined;
  /** Grants and links requested but not reapplied; each one is in `skipped_items`. */
  readonly permissions_skipped?: number | undefined;
  /** Grants and links left out because the restore ran without `restore_permissions`. */
  readonly permissions_not_requested?: number | undefined;
  readonly skipped_items?: readonly DriveRestoreSkippedItem[] | undefined;
}
