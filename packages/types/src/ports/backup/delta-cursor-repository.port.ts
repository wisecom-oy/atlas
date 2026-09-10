import type { MailboxDeltaCursor } from '../../domain/manifest';
import type { TenantContext } from '../tenant/context.port';

export interface MailboxDeltaCursorRepository {
  /** Loads the persisted delta cursor for a mailbox; undefined before the first save. */
  load(ctx: TenantContext, owner_id: string): Promise<MailboxDeltaCursor | undefined>;

  /**
   * Saves the cursor after a sync.
   *
   * Call it after the snapshot manifest is durable. A cursor that lands first tells the next run
   * to skip changes the manifest never recorded, which is what #339 was.
   */
  save(ctx: TenantContext, cursor: MailboxDeltaCursor): Promise<void>;
}
