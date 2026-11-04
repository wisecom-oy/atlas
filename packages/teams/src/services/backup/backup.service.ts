import { describe_failed_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { lock_run_writes } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  FailedItemLedger,
  TeamsBackupOptions,
  TeamsBackupResult,
  TeamsBackupSummary,
  TeamsBackupUseCase,
  TeamsChannelCursorRepository,
  TeamsChannelShardRepository,
  TeamsConnector,
  TeamsGraphResource,
  TeamsIndexRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_CHANNEL_CURSOR_REPOSITORY_TOKEN,
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_CONNECTOR_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import type { ChannelBackupOutput } from '@/services/backup/channel-backup-processor';
import {
  merge_channel_entries,
  split_owned_channels,
} from '@/services/backup/channel-entry-merger';
import { process_channels, type ChannelRunState } from '@/services/backup/channel-run-loop';
import { load_team_baseline, type TeamsBaseline } from '@/services/backup/team-baseline-loader';
import {
  persist_team_snapshot,
  save_channel_shards,
  type ChannelSave,
  type SnapshotPersistResult,
} from '@/services/backup/team-snapshot-persister';
import { normalize_team_id } from '@/services/shared/team-id';

@injectable()
export class TeamsBackupService implements TeamsBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_CONNECTOR_TOKEN) private readonly _connector: TeamsConnector,
    @inject(TEAMS_INDEX_REPOSITORY_TOKEN) private readonly _indexes: TeamsIndexRepository,
    @inject(TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN)
    private readonly _shards: TeamsChannelShardRepository,
    @inject(TEAMS_CHANNEL_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: TeamsChannelCursorRepository,
  ) {}

  /**
   * Backs up changed channel messages of a team and records an index of the result. A channel that
   * fails keeps its previous entry and cursor, and the run is reported as unhealthy.
   */
  async backup_team(
    tenant_id: string,
    team_id: string,
    options: TeamsBackupOptions = {},
  ): Promise<TeamsBackupResult> {
    const normalized_team_id = normalize_team_id(team_id);
    if (begin_operation_progress(options, 'backup', 'teams')) {
      finish_operation_progress(options, 'backup', 'teams', 0, 0);
      return empty_result(normalized_team_id);
    }
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const ctx = await lock_run_writes(tenant_ctx, options.object_lock_request);
      return await run_with_abort_signal(options.abort_signal, () =>
        this.run_backup(ctx, tenant_id, normalized_team_id, options),
      );
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async run_backup(
    ctx: TenantContext,
    tenant_id: string,
    team_id: string,
    options: TeamsBackupOptions,
  ): Promise<TeamsBackupResult> {
    const backup_at = new Date();
    const team = await this._connector.get_team(tenant_id, team_id);
    const members = await this._connector.list_team_members(tenant_id, team_id);
    const all_channels = await this._connector.list_channels(tenant_id, team_id);
    const team_tenant = typeof team.tenantId === 'string' ? team.tenantId : tenant_id;
    const { owned, warnings: ownership_warnings } = split_owned_channels(all_channels, team_tenant);
    const baseline = await load_team_baseline(
      ctx,
      { indexes: this._indexes, cursors: this._cursors },
      team_id,
      owned.map((channel) => channel.id),
    );
    emit_backup_progress(options, 'processing', 0);
    const scope: BackupRunScope = {
      ctx,
      connector: this._connector,
      tenant_id,
      team_id,
      backup_at: backup_at.toISOString(),
      counters: create_backup_counters(),
      should_interrupt: () =>
        options.should_interrupt?.() === true || options.abort_signal?.aborted === true,
      force_full: options.force_full === true,
    };
    const state = await process_channels(scope, owned, {
      baseline,
      shards: this._shards,
      options,
    });
    state.interrupted = state.interrupted || scope.should_interrupt();
    apply_baseline_findings(state, baseline);
    state.errors.push(...missing_channel_errors(options.channel_id, all_channels, team_id));
    const saves = await save_channel_shards(ctx, this._shards, state.results);
    const channels = merge_channel_entries({
      channels: all_channels,
      processed: new Map(saves.map((save) => [save.channel_id, save.entry])),
      previous: baseline.previous?.channels,
      backup_at: backup_at.toISOString(),
    });
    emit_backup_progress(options, 'finalizing', state.attempted);
    const persisted = await persist_team_snapshot(
      ctx,
      { indexes: this._indexes, cursors: this._cursors },
      {
        tenant_id,
        team_id,
        team_display_name: options.team_display_name ?? team.displayName,
        backup_at,
        team,
        members,
        channels,
        previous: baseline.previous,
        saves,
      },
    );
    finish_operation_progress(options, 'backup', 'teams', state.attempted, state.attempted);
    const failed_roots = pending_failed_roots(owned, state.results, baseline);
    return {
      team_id,
      snapshot: persisted.index,
      interrupted: state.interrupted,
      summary: summarize_run(scope, state, failed_roots, ownership_warnings, persisted, saves),
    };
  }
}

/** Reports a backup phase to the progress callback. */
function emit_backup_progress(
  options: TeamsBackupOptions,
  phase: 'processing' | 'finalizing',
  processed: number,
): void {
  emit_operation_progress(options, { operation: 'backup', workload: 'teams', phase, processed });
}

/** Adds the baseline's load errors and warnings to the run state. */
function apply_baseline_findings(state: ChannelRunState, baseline: TeamsBaseline): void {
  state.errors.push(...baseline.errors);
  state.warnings.push(...baseline.warnings);
}

/**
 * The failed roots the team still owes. A channel this run backed up reports its own ledger. Any
 * other channel keeps the failed roots stored in its cursor, so a channel the run did not reach
 * still counts against health.
 */
function pending_failed_roots(
  channels: TeamsGraphResource[],
  results: ReadonlyMap<string, ChannelBackupOutput>,
  baseline: TeamsBaseline,
): FailedItemLedger {
  const merged: FailedItemLedger = {};
  for (const channel of channels) {
    Object.assign(
      merged,
      results.get(channel.id)?.failed_roots ?? baseline.channels.get(channel.id)?.failed_roots,
    );
  }
  return merged;
}

function empty_result(team_id: string): TeamsBackupResult {
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
    },
  };
}

/**
 * Builds the run summary from the channel loop state and the index step's result. A run is healthy
 * only when it finished, failed no channel, and left no failed root behind. Only a healthy run
 * reports why it wrote no index.
 */
function summarize_run(
  scope: BackupRunScope,
  state: ChannelRunState,
  failed_roots: FailedItemLedger,
  ownership_warnings: string[],
  persisted: SnapshotPersistResult,
  saves: readonly ChannelSave[],
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
  };
}

/** Reports a requested channel id that the team does not list. */
function missing_channel_errors(
  channel_id: string | undefined,
  channels: TeamsGraphResource[],
  team_id: string,
): string[] {
  if (channel_id === undefined || channels.some((c) => c.id === channel_id)) {
    return [];
  }
  return [`Channel ${channel_id} is not in team ${team_id}`];
}
