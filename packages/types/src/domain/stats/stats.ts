export interface BucketStats {
  readonly tenant_id: string;
  readonly mailbox_count: number;
  readonly snapshot_count: number;
  readonly total_messages: number;
  readonly total_size_bytes: number;
  readonly attachment_count: number;
  readonly attachment_size_bytes: number;
  readonly monthly_breakdown: MonthlyBreakdown[];
  /** Wall-clock time spent in the pure aggregation step, in microseconds. */
  readonly aggregation_us: number;
}

export interface MailboxStats {
  readonly owner_id: string;
  readonly snapshot_count: number;
  readonly total_messages: number;
  readonly total_size_bytes: number;
  readonly attachment_count: number;
  readonly attachment_size_bytes: number;
  readonly folders: FolderStats[];
  readonly monthly_breakdown: MonthlyBreakdown[];
  /** Wall-clock time spent in the pure aggregation step, in microseconds. */
  readonly aggregation_us: number;
}

export interface FolderStats {
  readonly folder_id: string;
  readonly message_count: number;
  readonly total_size_bytes: number;
  readonly attachment_count: number;
  readonly attachment_size_bytes: number;
}

export interface MonthlyBreakdown {
  readonly month: string;
  readonly snapshot_count: number;
  readonly message_count: number;
  readonly size_bytes: number;
  readonly attachment_count: number;
  readonly attachment_size_bytes: number;
}

/** Per-owner (OneDrive) or per-site (SharePoint) rollup within drive statistics. */
export interface DriveOwnerSummary {
  /** OneDrive owner object ID or SharePoint site ID. */
  readonly owner_id: string;
  /** Human-readable label: owner email/display name or site URL/name. */
  readonly owner_label?: string;
  readonly snapshot_count: number;
  readonly file_count: number;
  readonly total_size_bytes: number;
  /** ISO timestamp of the most recent snapshot. */
  readonly latest_backup_at?: string;
}

export interface DriveMonthlyBreakdown {
  readonly month: string;
  readonly snapshot_count: number;
  readonly file_count: number;
  readonly total_size_bytes: number;
}

/** Aggregated statistics for OneDrive or SharePoint snapshot manifests. */
export interface DriveStats {
  readonly tenant_id: string;
  readonly service: 'onedrive' | 'sharepoint';
  readonly owner_count: number;
  readonly snapshot_count: number;
  readonly file_count: number;
  readonly total_size_bytes: number;
  readonly owners: DriveOwnerSummary[];
  readonly monthly_breakdown: DriveMonthlyBreakdown[];
  /** Wall-clock time spent in the pure aggregation step, in microseconds. */
  readonly aggregation_us: number;
}
