import type { SharePointDeltaCursor } from '../../domain/sharepoint-manifest';
import type { TenantContext } from '../tenant/context.port';

export interface SharePointDeltaCursorRepository {
  /** Loads the persisted delta cursor for a site. */
  load(ctx: TenantContext, site_id: string): Promise<SharePointDeltaCursor | undefined>;

  /** Saves the delta cursor state after a sync. */
  save(ctx: TenantContext, cursor: SharePointDeltaCursor): Promise<void>;
}
