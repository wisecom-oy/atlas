import { describe_failed_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { lock_run_writes } from '@wisecom/atlas-core/services/shared/run-object-lock';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  TeamsBackupOptions,
  TeamsBackupResult,
  TeamsBackupSummary,
  TeamsBackupUseCase,
  TeamsConnector,
  TeamsDeltaCursorRepository,
  TeamsGraphResource,
  TeamsManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_CONNECTOR_TOKEN,
  TEAMS_DELTA_CURSOR_REPOSITORY_TOKEN,
  TEAMS_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  merge_channel_entries,
  split_owned_channels,
} from '@/services/backup/channel-entry-merger';
import { process_channels, type ChannelRunState } from '@/services/backup/channel-run-loop';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  persist_team_snapshot,
  type SnapshotPersistResult,
} from '@/services/backup/team-snapshot-persister';

@injectable()
export class TeamsBackupService implements TeamsBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_CONNECTOR_TOKEN) private readonly _connector: TeamsConnector,
    @inject(TEAMS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: TeamsManifestRepository,
    @inject(TEAMS_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: TeamsDeltaCursorRepository,
  ) {}

  /**
   * Backs up changed channel messages of a team and records a snapshot of the result. A channel
   * that fails keeps its previous entry and delta link, and the run is reported as unhealthy.
   */
  async backup_team(
    tenant_id: string,
    team_id: string,
    options: TeamsBackupOptions = {},
  ): Promise<TeamsBackupResult> {
    const normalized_team_id = normalize_owner_id(team_id);
    if (begin_operation_progress(options, 'backup', 'teams')) {
      finish_operation_progress(options, 'backup', 'teams', 0, 0);
      return empty_result(normalized_team_id);
    }
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const ctx = await lock_run_writes(tenant_ctx, options.object_lock_request);
      return await this.run_backup(ctx, tenant_id, normalized_team_id, options);
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
    const stored_cursor = await this._cursors.load(ctx, team_id);
    const previous = await this._manifests.find_latest_by_team(ctx, team_id);
    const team = await this._connector.get_team(tenant_id, team_id);
    const members = await this._connector.list_team_members(tenant_id, team_id);
    const all_channels = await this._connector.list_channels(tenant_id, team_id);
    const { owned, warnings: ownership_warnings } = split_owned_channels(all_channels, tenant_id);
    emit_operation_progress(options, {
      operation: 'backup',
      workload: 'teams',
      phase: 'processing',
      processed: 0,
    });
    const scope: BackupRunScope = {
      ctx,
      connector: this._connector,
      tenant_id,
      team_id,
      backup_at: backup_at.toISOString(),
      counters: create_backup_counters(),
      should_interrupt: () => options.should_interrupt?.() === true,
      force_full: options.force_full === true,
    };
    const state = await process_channels(
      scope,
      owned,
      {
        previous_channels: previous?.channels,
        stored_links: stored_cursor?.delta_link_by_channel ?? {},
        options,
      },
      stored_cursor?.failed_roots ?? {},
    );
    state.errors.push(...missing_channel_errors(options.channel_id, all_channels, team_id));
    const channels = merge_channel_entries({
      channels: all_channels,
      processed: state.entries,
      previous: previous?.channels,
      backup_at: backup_at.toISOString(),
    });
    emit_operation_progress(options, {
      operation: 'backup',
      workload: 'teams',
      phase: 'finalizing',
      processed: state.attempted,
    });
    const persisted = await persist_team_snapshot(
      ctx,
      { manifests: this._manifests, cursors: this._cursors },
      {
        tenant_id,
        team_id,
        team_display_name: options.team_display_name ?? team.displayName,
        backup_at,
        team,
        members,
        channels,
        previous,
        links: state.links,
        channel_ids: new Set(all_channels.map((c) => c.id)),
        failed_roots: state.ledger,
      },
    );
    finish_operation_progress(options, 'backup', 'teams', state.attempted, state.attempted);
    return {
      team_id,
      snapshot: persisted.manifest,
      interrupted: state.interrupted,
      summary: summarize_run(scope, state, ownership_warnings, persisted),
    };
  }
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

/** Builds the run summary from the channel loop state and the snapshot step's result. */
function summarize_run(
  scope: BackupRunScope,
  state: ChannelRunState,
  ownership_warnings: string[],
  persisted: SnapshotPersistResult,
): TeamsBackupSummary {
  return {
    channels_scanned: state.attempted,
    ...scope.counters,
    cursor_updated: true,
    snapshot_created: persisted.manifest !== undefined,
    no_snapshot_reason: persisted.no_snapshot_reason,
    errors: state.errors,
    warnings: [...ownership_warnings, ...state.warnings, ...describe_failed_items(state.ledger)],
    healthy: !state.interrupted && state.errors.length === 0,
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
