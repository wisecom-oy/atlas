import { inject, injectable } from 'inversify';
import type {
  TeamsChannelCursorRepository,
  TeamsCursorScan,
  TeamsIndexRepository,
  TeamsSnapshotListing,
  TeamsStatusUseCase,
  TeamsTeamStatus,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  TEAMS_CHANNEL_CURSOR_REPOSITORY_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { MAX_HOSTED_RECHECK_ATTEMPTS } from '@/services/backup/hosted-recheck';

/**
 * Maps a team's newest readable index and its cursor scan to its status row. A team with no
 * readable index reports no backup.
 */
function team_status(
  team_id: string,
  listing: TeamsSnapshotListing,
  cursors: TeamsCursorScan,
): TeamsTeamStatus {
  const newest = listing.indexes[0];
  return {
    team_id,
    team_display_name: newest?.team_display_name,
    last_backup_at: newest?.created_at,
    last_snapshot_id: newest?.snapshot_id,
    total_channels: newest?.channels.length ?? 0,
    unreadable_keys: [...listing.unreadable_keys, ...cursors.unreadable_keys],
    unsupported_keys: [...listing.unsupported_keys, ...cursors.unsupported_keys],
    failed_root_count: cursors.cursors.reduce(
      (sum, cursor) => sum + Object.keys(cursor.failed_roots ?? {}).length,
      0,
    ),
    pending_recheck_count: cursors.cursors.reduce(
      (sum, cursor) =>
        sum +
        Object.values(cursor.hosted_recheck ?? {}).filter(
          (attempts) => attempts < MAX_HOSTED_RECHECK_ATTEMPTS,
        ).length,
      0,
    ),
  };
}

@injectable()
export class TeamsStatusService implements TeamsStatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(TEAMS_INDEX_REPOSITORY_TOKEN) private readonly _indexes: TeamsIndexRepository,
    @inject(TEAMS_CHANNEL_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: TeamsChannelCursorRepository,
  ) {}

  /**
   * Reports the newest readable backup run for each team in the tenant, with the index and cursor
   * keys that could not be read or were written by a newer format, and the failed-root count.
   * ponytail: decrypts every team's indexes per call, not one per team; indexes hold no content, so
   * this stays small. Cache the newest index per team if snapshot counts grow.
   */
  async check_teams_status(tenant_id: string): Promise<TeamsTeamStatus[]> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const teams = await this._indexes.list_teams(ctx);
      const rows: TeamsTeamStatus[] = [];
      for (const { team_id, listing } of teams) {
        const cursors = await this._cursors.scan(ctx, team_id);
        rows.push(team_status(team_id, listing, cursors));
      }
      return rows;
    } finally {
      ctx.destroy();
    }
  }
}
