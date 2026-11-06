import { NotFoundError } from '@wisecom/atlas-types';
import { inject, injectable } from 'inversify';
import type {
  TeamsCatalogUseCase,
  TeamsChannelShardRepository,
  TeamsConnector,
  TeamsGraphResource,
  TeamsIndexRepository,
  TeamsSnapshotListing,
  TeamsThreadListing,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_CONNECTOR_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { normalize_team_id } from '@/services/shared/team-id';

@injectable()
export class TeamsCatalogService implements TeamsCatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_CONNECTOR_TOKEN) private readonly _connector: TeamsConnector,
    @inject(TEAMS_INDEX_REPOSITORY_TOKEN) private readonly _indexes: TeamsIndexRepository,
    @inject(TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN)
    private readonly _shards: TeamsChannelShardRepository,
  ) {}

  /** Lists the teams in the tenant as Graph reports them. */
  async list_teams(tenant_id: string): Promise<TeamsGraphResource[]> {
    return this._connector.list_teams(tenant_id);
  }

  /** Lists the snapshot indexes recorded for a team, newest first, and any that could not be read. */
  async list_teams_snapshots(tenant_id: string, team_id: string): Promise<TeamsSnapshotListing> {
    return this.with_readonly_ctx(tenant_id, (ctx) =>
      this._indexes.list_by_team(ctx, normalize_team_id(team_id)),
    );
  }

  /** Lists every thread of one snapshot, flattened across its channels. */
  async list_snapshot_threads(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsThreadListing[]> {
    return this.with_readonly_ctx(tenant_id, async (ctx) => {
      const index = await this._indexes.find_by_snapshot(
        ctx,
        normalize_team_id(team_id),
        snapshot_id,
      );
      if (index === undefined) {
        throw new NotFoundError(`Teams snapshot ${snapshot_id} not found for team ${team_id}`);
      }
      const per_channel = await Promise.all(
        index.channels.map(async (channel) => {
          const shard = await this._shards.load(ctx, channel.shard_key);
          return Object.entries(shard.threads).map(([root_id, thread]) => ({
            ...thread,
            channel_id: channel.channel_id,
            root_id,
          }));
        }),
      );
      return per_channel.flat();
    });
  }

  private async with_readonly_ctx<T>(
    tenant_id: string,
    read: (ctx: TenantContext) => Promise<T>,
  ): Promise<T> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await read(ctx);
    } finally {
      ctx.destroy();
    }
  }
}
