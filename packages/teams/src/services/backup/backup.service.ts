import { apply_run_object_lock_policy } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  TeamsBackupOptions,
  TeamsBackupResult,
  TeamsBackupUseCase,
  TeamsChannelCheckpointRepository,
  TeamsChannelCursorRepository,
  TeamsChannelShardRepository,
  TeamsConnector,
  TeamsGraphResource,
  TeamsIndexRepository,
  OwnerLeases,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_CHANNEL_CHECKPOINT_REPOSITORY_TOKEN,
  TEAMS_CHANNEL_CURSOR_REPOSITORY_TOKEN,
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_CONNECTOR_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  OWNER_LEASES_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  attach_unreadable_keys,
} from '@wisecom/atlas-types';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import { build_channel_run_reports } from '@/services/backup/backup-run-report';
import {
  empty_result,
  pending_failed_roots,
  summarize_run,
  type RunReport,
} from '@/services/backup/backup-run-summary';
import {
  merge_channel_entries,
  split_owned_channels,
} from '@/services/backup/channel-entry-merger';
import { process_channels, select_channels } from '@/services/backup/channel-run-loop';
import { load_team_baseline } from '@/services/backup/team-baseline-loader';
import {
  persist_team_snapshot,
  save_channel_shards,
} from '@/services/backup/team-snapshot-persister';
import { resolve_channel_concurrency } from '@/services/backup/resolve-channel-concurrency';
import {
  run_with_teams_request_stats,
  TeamsRequestStats,
} from '@/services/backup/teams-request-stats';
import { normalize_team_id } from '@/services/shared/team-id';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

/** Per-run settings the team backup threads through its steps. */
interface RunSettings {
  readonly stats: TeamsRequestStats;
  readonly concurrency: number;
  /** The tenant context without the run's Object Lock, for checkpoint writes. */
  readonly checkpoint_ctx?: TenantContext | undefined;
  /** Damaged newer indexes the baseline skipped, filled once it loads, for the failure path. */
  readonly unreadable_keys: string[];
}

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
    @inject(TEAMS_CHANNEL_CHECKPOINT_REPOSITORY_TOKEN)
    private readonly _checkpoints: TeamsChannelCheckpointRepository,
    @inject(OWNER_LEASES_TOKEN) private readonly _leases: OwnerLeases,
  ) {}

  /**
   * Backs up changed channel messages of a team and records an index of the result. A channel that
   * fails keeps its previous entry and cursor, and the run is reported as unhealthy. A run that
   * throws after loading its baseline rethrows the same error, carrying the damaged index keys it
   * found (`attached_unreadable_keys`), so the caller can still name them (issue #694).
   */
  async backup_team(
    tenant_id: string,
    team_id: string,
    options: TeamsBackupOptions = {},
  ): Promise<TeamsBackupResult> {
    const normalized_team_id = normalize_team_id(team_id);
    const settings: RunSettings = {
      stats: new TeamsRequestStats(),
      concurrency: resolve_channel_concurrency(options.concurrency),
      unreadable_keys: [],
    };
    if (begin_operation_progress(options, 'backup', 'teams')) {
      finish_operation_progress(options, 'backup', 'teams', 0, 0);
      return empty_result(normalized_team_id);
    }
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const scope = {
        workload: 'teams',
        owner_id: normalized_team_id,
        operation: 'backup',
      } as const;
      return await this._leases.run_exclusive(tenant_ctx, scope, async (leased) => {
        const ctx = await apply_run_object_lock_policy(leased, options.object_lock_request);
        return run_with_abort_signal(options.abort_signal, () =>
          run_with_teams_request_stats(settings.stats, () =>
            this.run_backup(ctx, tenant_id, normalized_team_id, options, {
              ...settings,
              // Checkpoints are rewritten every page: never under the run's lock, always under its lease.
              checkpoint_ctx: leased,
            }),
          ),
        );
      });
    } catch (err) {
      throw attach_unreadable_keys(err, settings.unreadable_keys);
    } finally {
      tenant_ctx.destroy();
    }
  }

  private async run_backup(
    ctx: TenantContext,
    tenant_id: string,
    team_id: string,
    options: TeamsBackupOptions,
    settings: RunSettings,
  ): Promise<TeamsBackupResult> {
    const started = Date.now();
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
    append_all(settings.unreadable_keys, baseline.unreadable_keys);
    emit_backup_progress(options, 'processing', 0);
    const roots_applied = new Map<string, number>();
    const scope: BackupRunScope = {
      ctx,
      connector: this._connector,
      tenant_id,
      team_id,
      backup_at: backup_at.toISOString(),
      counters: create_backup_counters(),
      checkpoints: this._checkpoints,
      checkpoint_ctx: settings.checkpoint_ctx,
      progress: {
        roots_applied: (channel_id, count) => {
          roots_applied.set(channel_id, (roots_applied.get(channel_id) ?? 0) + count);
        },
      },
      should_interrupt: () =>
        options.should_interrupt?.() === true || options.abort_signal?.aborted === true,
      force_full: options.force_full === true,
    };
    const state = await process_channels(scope, owned, {
      baseline,
      shards: this._shards,
      options,
      concurrency: settings.concurrency,
    });
    state.interrupted = state.interrupted || scope.should_interrupt();
    append_all(state.warnings, baseline.warnings);
    append_all(state.errors, missing_channel_errors(options.channel_id, all_channels, team_id));
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
      {
        indexes: this._indexes,
        cursors: this._cursors,
        checkpoints: this._checkpoints,
        checkpoint_ctx: settings.checkpoint_ctx,
      },
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
    finish_operation_progress(
      options,
      'backup',
      'teams',
      state.attempted,
      state.attempted,
      state.interrupted,
    );
    const failed_roots = pending_failed_roots(owned, state.results, baseline);
    const elapsed_ms = Date.now() - started;
    const report: RunReport = {
      elapsed_ms,
      channels: build_channel_run_reports(
        select_channels(owned, options.channel_id),
        state,
        roots_applied,
      ),
      requests: settings.stats.snapshot(elapsed_ms),
      ...(baseline.unreadable_keys.length > 0 ? { unreadable_keys: baseline.unreadable_keys } : {}),
    };
    return {
      team_id,
      snapshot: persisted.index,
      interrupted: state.interrupted,
      summary: summarize_run(
        scope,
        state,
        failed_roots,
        ownership_warnings,
        persisted,
        saves,
        report,
      ),
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
