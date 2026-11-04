import { NotFoundError } from '@wisecom/atlas-types';
import { inject, injectable } from 'inversify';
import type {
  TeamsCatalogUseCase,
  TeamsConnector,
  TeamsGraphResource,
  TeamsManifestRepository,
  TeamsSnapshotManifest,
  TeamsThreadListing,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_CONNECTOR_TOKEN,
  TEAMS_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { normalize_team_id } from '@/services/shared/team-id';

@injectable()
export class TeamsCatalogService implements TeamsCatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_CONNECTOR_TOKEN) private readonly _connector: TeamsConnector,
    @inject(TEAMS_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: TeamsManifestRepository,
  ) {}

  /** Lists the teams in the tenant as Graph reports them. */
  async list_teams(tenant_id: string): Promise<TeamsGraphResource[]> {
    return this._connector.list_teams(tenant_id);
  }

  /** Lists the snapshot manifests recorded for a team, newest first. */
  async list_teams_snapshots(tenant_id: string, team_id: string): Promise<TeamsSnapshotManifest[]> {
    return this.with_readonly_ctx(tenant_id, (ctx) =>
      this._manifests.list_snapshots_by_team(ctx, normalize_team_id(team_id)),
    );
  }

  /** Lists every thread of one snapshot, flattened across its channels. */
  async list_snapshot_threads(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
  ): Promise<TeamsThreadListing[]> {
    return this.with_readonly_ctx(tenant_id, async (ctx) => {
      const manifest = await this._manifests.find_by_snapshot(
        ctx,
        normalize_team_id(team_id),
        snapshot_id,
      );
      if (manifest === undefined) {
        throw new NotFoundError(`Teams snapshot ${snapshot_id} not found for team ${team_id}`);
      }
      return manifest.channels.flatMap((channel) =>
        Object.entries(channel.threads).map(([root_id, entry]) => ({
          ...entry,
          channel_id: channel.id,
          root_id,
        })),
      );
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
