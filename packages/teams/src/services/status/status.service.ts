import { inject, injectable } from 'inversify';
import type {
  TeamsIndexRepository,
  TeamsSnapshotListing,
  TeamsStatusUseCase,
  TeamsTeamStatus,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { TEAMS_INDEX_REPOSITORY_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';

/**
 * Maps a team's newest readable index to its status row, carrying the keys the listing skipped.
 * A team with no readable index reports no backup.
 */
function team_status(team_id: string, listing: TeamsSnapshotListing): TeamsTeamStatus {
  const newest = listing.indexes[0];
  return {
    team_id,
    team_display_name: newest?.team_display_name,
    last_backup_at: newest?.created_at,
    last_snapshot_id: newest?.snapshot_id,
    total_channels: newest?.channels.length ?? 0,
    unreadable_keys: listing.unreadable_keys,
    unsupported_keys: listing.unsupported_keys,
  };
}

@injectable()
export class TeamsStatusService implements TeamsStatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_INDEX_REPOSITORY_TOKEN) private readonly _indexes: TeamsIndexRepository,
  ) {}

  /**
   * Reports the newest readable backup run for each team in the tenant, with the index keys that
   * could not be read or were written by a newer format.
   * ponytail: decrypts every team's indexes per call, not one per team; indexes hold no content, so
   * this stays small. Cache the newest index per team if snapshot counts grow.
   */
  async check_teams_status(tenant_id: string): Promise<TeamsTeamStatus[]> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const teams = await this._indexes.list_teams(ctx);
      return teams.map(({ team_id, listing }) => team_status(team_id, listing));
    } finally {
      ctx.destroy();
    }
  }
}
