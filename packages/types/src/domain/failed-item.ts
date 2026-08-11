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
  readonly first_failed_at: string;
  readonly last_failed_at: string;
}

/** Failed items keyed by item id, as persisted in a delta cursor. */
export type FailedItemLedger = Record<string, FailedItemRecord>;
