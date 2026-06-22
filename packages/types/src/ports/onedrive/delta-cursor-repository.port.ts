import type { OneDriveDeltaCursor } from '../../domain/onedrive-manifest';
import type { TenantContext } from '../tenant/context.port';

export interface OneDriveDeltaCursorRepository {
  /** Loads the persisted delta cursor for a user. */
  load(ctx: TenantContext, owner_id: string): Promise<OneDriveDeltaCursor | undefined>;

  /** Saves the delta cursor state after a sync. */
  save(ctx: TenantContext, cursor: OneDriveDeltaCursor): Promise<void>;
}
