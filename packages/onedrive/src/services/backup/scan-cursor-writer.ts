import type {
  FailedItemLedger,
  OneDriveDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import type { DriveTrackingState } from '@/services/backup/delta-item-processor';

/**
 * Persists the cursor after one drive's scan, before the manifest exists.
 *
 * Saved even when items failed: the successful entries are real, and the ledger riding along is what
 * keeps the failures from being forgotten.
 *
 * The scope is recorded here, not only at finalize. This save advances the delta link, so a run that
 * crashes after it must leave behind a cursor saying which scope those links were advanced under.
 * Omitting it would let the next whole-drive run resume a link that had already consumed, and
 * filtered away, changes outside the scope.
 */
export async function persist_scan_cursor(
  cursors: OneDriveDeltaCursorRepository,
  ctx: TenantContext,
  owner_id: string,
  delta_link_by_drive: Record<string, string>,
  tracking_state: DriveTrackingState,
  failed_items: FailedItemLedger,
  folder_scope: string | undefined,
): Promise<void> {
  await cursors.save(ctx, {
    owner_id,
    delta_link_by_drive,
    ...tracking_state,
    failed_items,
    ...(folder_scope !== undefined ? { folder_scope } : {}),
    updated_at: new Date().toISOString(),
  });
}
