import type { TeamsDeltaCursor } from '@/domain/teams-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

export interface TeamsDeltaCursorRepository {
  /** Loads the persisted delta cursor for a team. */
  load(ctx: TenantContext, team_id: string): Promise<TeamsDeltaCursor | undefined>;

  /** Saves the delta cursor after the manifest its links were read against is durable. */
  save(ctx: TenantContext, cursor: TeamsDeltaCursor): Promise<void>;
}
