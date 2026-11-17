import type { ArchiveTarget } from '@wisecom/atlas-core/services/shared/file-save-zip-writer';
import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import {
  resolve_save_target,
  settle_empty_save_target,
  settle_failed_save_target,
} from '@wisecom/atlas-core/services/shared/save-archive-target';
import { inject, injectable } from 'inversify';
import {
  NotFoundError,
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  type TeamsChannelIndexEntry,
  type TeamsChannelShardRepository,
  type TeamsIndexRepository,
  type TeamsSaveOptions,
  type TeamsSaveResult,
  type TeamsSaveUseCase,
  type TeamsSnapshotIndex,
  type TenantContext,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { normalize_team_id } from '@/services/shared/team-id';
import { write_save_archive, type ArchiveWriteRequest } from '@/services/save/save-archive-writer';

/** Saves one snapshot of a team as a browsable zip. Reads storage only; never calls Graph. */
@injectable()
export class TeamsSaveService implements TeamsSaveUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_INDEX_REPOSITORY_TOKEN) private readonly _indexes: TeamsIndexRepository,
    @inject(TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN)
    private readonly _shards: TeamsChannelShardRepository,
  ) {}

  /** Writes the snapshot (or one channel of it) to the output zip and reports what was saved. */
  async save_snapshot(
    tenant_id: string,
    team_id: string,
    options: TeamsSaveOptions,
  ): Promise<TeamsSaveResult> {
    const normalized_team_id = normalize_team_id(team_id);
    // Resolved before anything else so a failure below can still settle the target.
    const { target, output_path } = resolve_save_target(options, () =>
      build_default_output_path(options.snapshot_id),
    );
    try {
      if (begin_operation_progress(options, 'save', 'teams')) {
        finish_operation_progress(options, 'save', 'teams', 0, 0);
        await settle_empty_save_target(target, true);
        return empty_save_result(options.snapshot_id, options.output_path ?? '', true);
      }
      const ctx = await this._tenant_factory.create_readonly(tenant_id);
      try {
        return await this.save_with_context(ctx, normalized_team_id, target, output_path, options);
      } finally {
        ctx.destroy();
      }
    } catch (err) {
      settle_failed_save_target(target);
      throw err;
    }
  }

  private async save_with_context(
    ctx: TenantContext,
    team_id: string,
    target: ArchiveTarget,
    output_path: string,
    options: TeamsSaveOptions,
  ): Promise<TeamsSaveResult> {
    const index = await this._indexes.find_by_snapshot(ctx, team_id, options.snapshot_id);
    if (index === undefined) {
      throw new NotFoundError(
        `Teams snapshot ${options.snapshot_id} not found for team ${team_id}`,
      );
    }
    const channels = select_channels(index, options.channel_id);
    if (channels.length === 0) {
      const interrupted = finish_operation_progress(options, 'save', 'teams', 0, 0);
      await settle_empty_save_target(target, interrupted);
      return empty_save_result(options.snapshot_id, options.output_path ?? '', interrupted);
    }
    const request: ArchiveWriteRequest = {
      ctx,
      shards: this._shards,
      team_id,
      index,
      channels,
      target,
      output_path,
      options,
    };
    return await write_save_archive(request);
  }
}

/** The whole snapshot, or the one channel the caller named. */
function select_channels(
  index: TeamsSnapshotIndex,
  channel_id: string | undefined,
): TeamsChannelIndexEntry[] {
  if (channel_id === undefined) return index.channels;
  const matches = index.channels.filter((channel) => channel.channel_id === channel_id);
  if (matches.length === 0) {
    throw new NotFoundError(
      `Channel ${channel_id} not found in Teams snapshot ${index.snapshot_id}`,
    );
  }
  return matches;
}

function empty_save_result(
  snapshot_id: string,
  output_path: string,
  interrupted: boolean,
): TeamsSaveResult {
  return {
    snapshot_id,
    channels_saved: 0,
    messages_saved: 0,
    images_inlined: 0,
    hosted_files: 0,
    hosted_missing: [],
    errors: [],
    output_path,
    total_bytes: 0,
    interrupted,
  };
}

function build_default_output_path(snapshot_id: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `teams-${snapshot_id}-${ts}.zip`;
}
