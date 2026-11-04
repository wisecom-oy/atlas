import type { TeamsConnector, TenantContext } from '@wisecom/atlas-types';

/** Work counts one backup run accumulates for its summary. */
export interface BackupCounters {
  channels_full_read: number;
  threads_changed: number;
  threads_stored: number;
  threads_deduplicated: number;
  threads_deleted: number;
  hosted_content_stored: number;
}

/** Everything a channel and thread step needs from the run that owns it. */
export interface BackupRunScope {
  readonly ctx: TenantContext;
  readonly connector: TeamsConnector;
  readonly tenant_id: string;
  readonly team_id: string;
  /** ISO timestamp of the run, stamped on every entry the run writes. */
  readonly backup_at: string;
  readonly counters: BackupCounters;
  readonly should_interrupt: () => boolean;
}

/** Returns zeroed counters for a new run. */
export function create_backup_counters(): BackupCounters {
  return {
    channels_full_read: 0,
    threads_changed: 0,
    threads_stored: 0,
    threads_deduplicated: 0,
    threads_deleted: 0,
    hosted_content_stored: 0,
  };
}
