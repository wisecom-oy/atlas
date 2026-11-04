import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import {
  NotFoundError,
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  TeamsChannelShardRepository,
  TeamsIndexRepository,
  TeamsSnapshotIndex,
  TeamsVerificationResult,
  TeamsVerificationUseCase,
  TenantContext,
  TenantContextFactory,
  VerificationOptions,
} from '@wisecom/atlas-types';
import { normalize_team_id } from '@/services/shared/team-id';
import { message_thread_blobs } from '@/services/shared/thread-blobs';
import {
  check_channel_shards,
  check_message_blobs,
  IntegrityTally,
} from '@/services/verification/integrity-checks';

@injectable()
export class TeamsVerificationService implements TeamsVerificationUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_INDEX_REPOSITORY_TOKEN) private readonly _indexes: TeamsIndexRepository,
    @inject(TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN)
    private readonly _shards: TeamsChannelShardRepository,
  ) {}

  /**
   * Checks every object a snapshot references: each channel shard, then each message, hosted, and
   * kept blob its threads reference. Shards are always loaded, so `fast` only skips the download
   * and checksum of each message blob and checks that it exists.
   */
  async verify_teams_snapshot(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
    options: VerificationOptions = {},
  ): Promise<TeamsVerificationResult> {
    const normalized_team_id = normalize_team_id(team_id);
    if (begin_operation_progress(options, 'verify', 'teams')) {
      finish_operation_progress(options, 'verify', 'teams', 0, 0);
      return {
        snapshot_id,
        total_checked: 0,
        passed: 0,
        failed_storage_keys: [],
        missing_storage_keys: [],
        interrupted: true,
      };
    }
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const index = await this._indexes.find_by_snapshot(ctx, normalized_team_id, snapshot_id);
      if (index === undefined) {
        throw new NotFoundError(
          `Teams snapshot ${snapshot_id} not found for team ${normalized_team_id}`,
        );
      }
      return await this.verify_index(ctx, index, options);
    } finally {
      ctx.destroy();
    }
  }

  /** Checks the shards an index lists, then the blobs of every shard that loaded. */
  private async verify_index(
    ctx: TenantContext,
    index: TeamsSnapshotIndex,
    options: VerificationOptions,
  ): Promise<TeamsVerificationResult> {
    const shard_keys = index.channels.map((channel) => channel.shard_key);
    const shard_tally = new IntegrityTally();
    const shards = await check_channel_shards(ctx, this._shards, shard_keys, options, shard_tally);
    const refs = shards.loaded.flatMap((shard) =>
      Object.values(shard.threads).flatMap(message_thread_blobs),
    );
    const blob_tally = new IntegrityTally();
    const blobs_interrupted = await check_message_blobs(ctx, refs, options, blob_tally);

    const total_checked = shard_tally.checked + blob_tally.checked;
    const missing_storage_keys = [
      ...shard_tally.missing_storage_keys,
      ...blob_tally.missing_storage_keys,
    ];
    const failed_storage_keys = [
      ...shard_tally.failed_storage_keys,
      ...blob_tally.failed_storage_keys,
    ];
    const interrupted = finish_operation_progress(
      options,
      'verify',
      'teams',
      total_checked,
      shard_keys.length + refs.length,
      shards.interrupted || blobs_interrupted,
    );
    return {
      snapshot_id: index.snapshot_id,
      total_checked,
      passed: total_checked - missing_storage_keys.length - failed_storage_keys.length,
      failed_storage_keys,
      missing_storage_keys,
      interrupted,
    };
  }
}
