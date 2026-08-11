import type { OneDriveConnector, OneDriveDeltaItem } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  clear_item_failure,
  record_item_failure,
  retryable_items,
  type FailedItemLedger,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';

export interface RetryResolution {
  /** Items to push through the normal per-item pipeline ahead of new delta changes. */
  items: OneDriveDeltaItem[];
  /** Ledger with vanished items dropped and unreachable ones re-recorded. */
  ledger: FailedItemLedger;
}

/**
 * Re-fetches the drive's outstanding failures so they get another pass.
 *
 * Delta only reports items that changed, so a file that failed while unchanged
 * would never come back on its own -- it has to be pulled by id. Items past
 * their retry budget are skipped here but stay in the ledger so they keep being
 * reported. Items already present in the incoming delta batch are skipped too:
 * the delta copy is fresher and processing both would double the work.
 */
export async function resolve_retry_items(
  connector: OneDriveConnector,
  tenant_id: string,
  owner_id: string,
  drive_id: string,
  ledger: FailedItemLedger,
  delta_item_ids: ReadonlySet<string>,
): Promise<RetryResolution> {
  const items: OneDriveDeltaItem[] = [];
  let next_ledger = ledger;

  for (const record of retryable_items(ledger, drive_id)) {
    if (delta_item_ids.has(record.item_id)) continue;

    try {
      const item = await connector.fetch_item_by_id(tenant_id, owner_id, drive_id, record.item_id);
      if (item) {
        items.push(item);
        continue;
      }
      logger.info(`Previously failed item ${record.name} (${record.item_id}) no longer exists`);
      next_ledger = clear_item_failure(next_ledger, record.item_id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      next_ledger = record_item_failure(next_ledger, {
        item_id: record.item_id,
        drive_id,
        name: record.name,
        reason: `Retry fetch failed: ${reason}`,
      });
    }
  }

  return { items, ledger: next_ledger };
}
