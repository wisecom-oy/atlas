import { describe_failed_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type {
  FailedItemLedger,
  TeamsBackupResult,
  TeamsBackupSummary,
  TeamsGraphResource,
} from '@wisecom/atlas-types';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import type { ChannelBackupOutput } from '@/services/backup/channel-backup-processor';
import type { ChannelRunState } from '@/services/backup/channel-run-loop';
import type { TeamsBaseline } from '@/services/backup/team-baseline-loader';
import type { ChannelSave, SnapshotPersistResult } from '@/services/backup/team-snapshot-persister';
import { TeamsRequestStats } from '@/services/backup/teams-request-stats';

/**
 * Summary fields the run records itself: wall-clock time, channel outcomes, request counts, and
 * the newer indexes it could not read.
 */
export type RunReport = Pick<
  TeamsBackupSummary,
  'elapsed_ms' | 'channels' | 'requests' | 'unreadable_keys'
>;

/**
 * The failed roots the team still owes. A channel this run backed up reports its own ledger. Any
 * other channel keeps the failed roots stored in its cursor, so a channel the run did not reach
 * still counts against health.
 */
export function pending_failed_roots(
  channels: TeamsGraphResource[],
  results: ReadonlyMap<string, ChannelBackupOutput>,
  baseline: TeamsBaseline,
): FailedItemLedger {
  const merged: FailedItemLedger = {};
  for (const channel of channels) {
    const ledger =
      results.get(channel.id)?.failed_roots ??
      baseline.channels.get(channel.id)?.failed_roots ??
      {};
    for (const [root_id, record] of Object.entries(ledger)) {
      merged[`${channel.id}/${root_id}`] = record;
    }
  }
  return merged;
}

/** The result of a run that another run already holds. It backed up nothing and is interrupted. */
export function empty_result(team_id: string): TeamsBackupResult {
  return {
    team_id,
    snapshot: undefined,
    interrupted: true,
    summary: {
      channels_scanned: 0,
      ...create_backup_counters(),
      cursor_updated: false,
      snapshot_created: false,
      errors: [],
      warnings: [],
      healthy: false,
      elapsed_ms: 0,
      channels: [],
      requests: new TeamsRequestStats().snapshot(0),
    },
  };
}

/**
 * Builds the run summary from the channel loop state and the index step's result. A run is healthy
 * only when it finished, failed no channel, and left no failed root behind. Only a healthy run
 * reports why it wrote no index.
 */
export function summarize_run(
  scope: BackupRunScope,
  state: ChannelRunState,
  failed_roots: FailedItemLedger,
  ownership_warnings: string[],
  persisted: SnapshotPersistResult,
  saves: readonly ChannelSave[],
  report: RunReport,
): TeamsBackupSummary {
  const healthy =
    !state.interrupted && state.errors.length === 0 && Object.keys(failed_roots).length === 0;
  return {
    channels_scanned: state.attempted,
    ...scope.counters,
    cursor_updated: saves.length > 0,
    snapshot_created: persisted.index !== undefined,
    no_snapshot_reason: healthy ? persisted.no_snapshot_reason : undefined,
    errors: state.errors,
    warnings: [...ownership_warnings, ...state.warnings, ...describe_failed_items(failed_roots)],
    healthy,
    ...report,
  };
}
