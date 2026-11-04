import { randomBytes } from 'node:crypto';
import { lock_run_writes } from '@wisecom/atlas-core/services/shared/run-object-lock';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { inject, injectable } from 'inversify';
import type {
  TeamsBackupOptions,
  TeamsBackupResult,
  TeamsBackupUseCase,
  TeamsChannelEntry,
  TeamsSnapshotManifest,
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
  build_teams_cursor,
  build_teams_manifest,
} from '@/services/backup/backup-manifest-builder';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { create_backup_counters, type BackupRunScope } from '@/services/backup/backup-run-scope';

/** What the channel loop produced: entries and links for channels it finished, plus run flags. */
interface ChannelRunState {
  readonly entries: Map<string, TeamsChannelEntry>;
  readonly links: Record<string, string>;
  readonly errors: string[];
  attempted: number;
  interrupted: boolean;
}

/** Read-only inputs for one channel step: the previous snapshot, stored links, and run options. */
interface ChannelRunInputs {
  readonly previous_channels: TeamsChannelEntry[] | undefined;
  readonly stored_links: Record<string, string>;
  readonly options: TeamsBackupOptions;
}

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
    if (begin_operation_progress(options, 'backup', 'teams')) {
      finish_operation_progress(options, 'backup', 'teams', 0, 0);
      return empty_result(team_id);
    }
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    try {
      const ctx = await lock_run_writes(tenant_ctx, options.object_lock_request);
      return await this.run_backup(ctx, tenant_id, team_id, options);
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
    };
    const stored_links = stored_cursor?.delta_link_by_channel ?? {};
    const state = await this.process_channels(
      scope,
      all_channels,
      stored_links,
      previous?.channels,
      options,
    );
    if (
      options.channel_id !== undefined &&
      !all_channels.some((c) => c.id === options.channel_id)
    ) {
      state.errors.push(`Channel ${options.channel_id} is not in team ${team_id}`);
    }
    const channels = all_channels.flatMap((channel) => {
      const entry =
        state.entries.get(channel.id) ?? previous?.channels.find((c) => c.id === channel.id);
      return entry === undefined ? [] : [entry];
    });
    emit_operation_progress(options, {
      operation: 'backup',
      workload: 'teams',
      phase: 'finalizing',
      processed: state.attempted,
    });
    const manifest = await this.persist_snapshot(ctx, {
      tenant_id,
      team_id,
      team_display_name: options.team_display_name ?? team.displayName,
      backup_at,
      team,
      members,
      channels,
      links: state.links,
      channel_ids: new Set(all_channels.map((c) => c.id)),
    });
    finish_operation_progress(options, 'backup', 'teams', state.attempted, state.attempted);
    const healthy = !state.interrupted && state.errors.length === 0;
    return {
      team_id,
      snapshot: manifest,
      interrupted: state.interrupted,
      summary: {
        channels_scanned: state.attempted,
        ...scope.counters,
        cursor_updated: true,
        snapshot_created: true,
        errors: state.errors,
        warnings: [],
        healthy,
      },
    };
  }

  /** Saves the snapshot manifest, then the cursor that points past it (#339). */
  private async persist_snapshot(
    ctx: TenantContext,
    input: {
      tenant_id: string;
      team_id: string;
      team_display_name: string | undefined;
      backup_at: Date;
      team: TeamsGraphResource;
      members: TeamsGraphResource[];
      channels: TeamsChannelEntry[];
      links: Parameters<typeof build_teams_cursor>[1];
      channel_ids: Set<string>;
    },
  ): Promise<TeamsSnapshotManifest> {
    const snapshot_id = `teams-snap-${input.backup_at.getTime()}-${randomBytes(3).toString('hex')}`;
    const manifest = build_teams_manifest({
      tenant_id: input.tenant_id,
      team_id: input.team_id,
      team_display_name: input.team_display_name,
      snapshot_id,
      created_at: input.backup_at,
      team: input.team,
      members: input.members,
      channels: input.channels,
    });
    await this._manifests.save(ctx, manifest);
    const cursor = build_teams_cursor(
      input.team_id,
      input.links,
      input.channel_ids,
      input.backup_at.toISOString(),
    );
    await this._cursors.save(ctx, cursor);
    return manifest;
  }

  /**
   * Processes the selected channels in order. Stops at the first interruption. A channel that
   * fails is recorded and skipped, so the others still run.
   */
  private async process_channels(
    scope: BackupRunScope,
    channels: TeamsGraphResource[],
    stored_links: Record<string, string>,
    previous_channels: TeamsChannelEntry[] | undefined,
    options: TeamsBackupOptions,
  ): Promise<ChannelRunState> {
    const state: ChannelRunState = {
      entries: new Map(),
      links: { ...stored_links },
      errors: [],
      attempted: 0,
      interrupted: false,
    };
    for (const channel of channels) {
      if (options.channel_id !== undefined && channel.id !== options.channel_id) {
        continue;
      }
      if (scope.should_interrupt()) {
        state.interrupted = true;
        break;
      }
      state.attempted++;
      const continues = await this.run_channel(scope, channel, state, {
        previous_channels,
        stored_links,
        options,
      });
      if (!continues) {
        state.interrupted = true;
        break;
      }
    }
    return state;
  }

  /** Backs up one channel into `state`. Returns false when the run was interrupted during it. */
  private async run_channel(
    scope: BackupRunScope,
    channel: TeamsGraphResource,
    state: ChannelRunState,
    inputs: ChannelRunInputs,
  ): Promise<boolean> {
    const previous_entry = inputs.previous_channels?.find((c) => c.id === channel.id);
    const prev_link =
      inputs.options.force_full === true ? undefined : inputs.stored_links[channel.id];
    try {
      const output = await backup_channel(scope, channel, previous_entry, prev_link);
      if (output === undefined) {
        return false;
      }
      state.entries.set(channel.id, output.entry);
      if (output.next_link === undefined) {
        delete state.links[channel.id];
      } else {
        state.links[channel.id] = output.next_link;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Teams channel ${channel.id} backup failed: ${message}`);
      state.errors.push(`Channel ${channel.id}: ${message}`);
    }
    return true;
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
