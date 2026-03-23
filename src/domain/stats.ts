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
  readonly mailbox_id: string;
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
