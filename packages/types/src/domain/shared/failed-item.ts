/**
 * Record of a drive item that failed to back up.
 *
 * Drive backups advance their delta link past per-item failures so one poison
 * file cannot freeze a drive's incrementals. Because delta never re-presents an
 * unchanged item, the failure has to be remembered explicitly or the file is
 * silently never backed up again -- hence this record, persisted in the drive's
 * delta cursor and retried by later runs.
 */
export interface FailedItemRecord {
  readonly item_id: string;
  readonly drive_id: string;
  readonly name: string;
  readonly reason: string;
  /** Backup runs that have tried and failed on this item. */
  readonly attempts: number;
  /**
   * Set when the service refuses the content by policy rather than failing
   * transiently, so no number of retries can change the outcome. A
   * malware-quarantined item is the canonical case. Permanent records are
   * reported on every run but never re-fetched, and they do not consume the
   * attempt budget, which exists for failures that might still succeed.
   */
  readonly permanent?: boolean;
  /**
   * Set while the item's re-read by id keeps answering "not found". One such answer is not proof
   * of deletion, so the item stays listed until the streak confirms it (issue #850). Any other
   * outcome for the item ends the streak.
   */
  readonly not_found?: NotFoundStreak;
  readonly first_failed_at: string;
  readonly last_failed_at: string;
}

/** Consecutive runs whose re-read of a failed item answered "not found". */
export interface NotFoundStreak {
  /** Runs in a row whose re-read answered "not found". */
  readonly reads: number;
  /** When the first of those reads happened, as an ISO timestamp. */
  readonly since: string;
}

/** Failed items keyed by item id, as persisted in a delta cursor. */
export type FailedItemLedger = Record<string, FailedItemRecord>;
