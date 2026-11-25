import { is_graph_outage } from '@wisecom/atlas-core/services/shared/graph-outage-latch';
import type { OneDriveConnector, OneDriveDeltaItem } from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  record_item_failure,
  retryable_items,
  type FailedItemLedger,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { is_transient_drive_failure } from '@wisecom/atlas-drive/backup/transient-download-failure';
import { resolve_retry_read_not_found } from '@wisecom/atlas-drive/backup/retry-read-not-found';

export interface RetryResolution {
  /** Items to push through the normal per-item pipeline ahead of new delta changes. */
  items: OneDriveDeltaItem[];
  /** Ledger with confirmed deletions dropped and unreachable or unconfirmed ones re-recorded. */
  ledger: FailedItemLedger;
  interrupted: boolean;
}

/**
 * Re-fetches the drive's outstanding failures so they get another pass.
 *
 * Delta only reports items that changed, so a file that failed while unchanged
 * would never come back on its own -- it has to be pulled by id. Items past
 * their retry budget are skipped here but stay in the ledger so they keep being
 * reported. Items already present in the incoming delta batch are skipped too:
 * the delta copy is fresher and processing both would double the work. A read
 * that fails for a reason outside the file, such as an outage or throttling,
 * spends none of the item's attempts (issue #857). A "not found" answer keeps the item listed until
 * the deletion is confirmed, because one `404` is not proof the file is gone (issue #850).
 */
export async function resolve_retry_items(
  connector: OneDriveConnector,
  tenant_id: string,
  owner_id: string,
  drive_id: string,
  ledger: FailedItemLedger,
  delta_item_ids: ReadonlySet<string>,
  should_interrupt?: () => boolean,
): Promise<RetryResolution> {
  const items: OneDriveDeltaItem[] = [];
  let next_ledger = ledger;

  for (const record of retryable_items(ledger, drive_id)) {
    if (should_interrupt?.() === true) return { items, ledger: next_ledger, interrupted: true };
    if (delta_item_ids.has(record.item_id)) continue;

    try {
      const item = await connector.fetch_item_by_id(tenant_id, owner_id, drive_id, record.item_id);
      if (item) {
        items.push(item);
        continue;
      }
      next_ledger = resolve_retry_read_not_found(next_ledger, record);
    } catch (err) {
      if (is_unrecordable_fetch_failure(err)) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      next_ledger = record_item_failure(next_ledger, {
        item_id: record.item_id,
        drive_id,
        name: record.name,
        reason: `Retry fetch failed: ${reason}`,
        // An outage or throttling says nothing about the file, so it keeps its attempts (#857).
        consumes_attempt: !is_transient_drive_failure(err),
      });
    }
  }

  return { items, ledger: next_ledger, interrupted: false };
}

/**
 * A fetch failure that must not be recorded against the item. A revoked grant is not a per-item
 * fault, and re-recording it 12 times per run tells the operator nothing; this matches the
 * SharePoint twin (issue #371). A fetch cut short by cancellation keeps the attempt count the item
 * already had, and the drive scan treats the throw as the run stopping (issue #673). A Graph outage
 * (an exhausted retry budget) is not the item's fault either, and fails the drive (issue #881).
 */
function is_unrecordable_fetch_failure(err: unknown): boolean {
  return err instanceof AuthError || is_graph_outage(err) || is_active_run_cancelled();
}
