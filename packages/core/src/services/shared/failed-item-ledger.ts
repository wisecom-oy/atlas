/**
 * Bookkeeping for drive items that failed to back up.
 *
 * Drive backups advance their delta link past per-item failures, so one poison
 * file cannot freeze a drive's incrementals. Advancing is only safe with an
 * explicit record: delta never re-presents an unchanged item, so a failure that
 * is merely logged becomes a file that silently never gets backed up again.
 *
 * The ledger therefore rides in the delta cursor. Each run re-fetches the items
 * it holds before processing new delta changes, and stops retrying -- while
 * still reporting -- once an item has burned its attempt budget.
 *
 * Shared by the OneDrive and SharePoint pipelines so both behave identically.
 */

import type { FailedItemLedger, FailedItemRecord } from '@wisecom/atlas-types';

export type { FailedItemLedger, FailedItemRecord };
/**
 * Retry budget per item. Past this an item is reported on every run but no
 * longer re-fetched, so a permanently broken file costs one line of output
 * instead of a download attempt on every backup, forever.
 */
export const MAX_FAILED_ITEM_ATTEMPTS = 5;

/** Returns the ledger with this failure recorded, incrementing the item's attempt count. */
export function record_item_failure(
  ledger: FailedItemLedger,
  failure: {
    item_id: string;
    drive_id: string;
    name: string;
    reason: string;
    /** The service refuses this content by policy; retrying cannot help. */
    permanent?: boolean;
  },
): FailedItemLedger {
  const now = new Date().toISOString();
  const previous = ledger[failure.item_id];

  return {
    ...ledger,
    [failure.item_id]: {
      item_id: failure.item_id,
      drive_id: failure.drive_id,
      name: failure.name,
      reason: failure.reason,
      attempts: (previous?.attempts ?? 0) + 1,
      ...(failure.permanent === true ? { permanent: true } : {}),
      first_failed_at: previous?.first_failed_at ?? now,
      last_failed_at: now,
    },
  };
}

/** Returns the ledger without this item -- it backed up, or no longer exists. */
export function clear_item_failure(ledger: FailedItemLedger, item_id: string): FailedItemLedger {
  if (!(item_id in ledger)) return ledger;
  const { [item_id]: _cleared, ...rest } = ledger;
  return rest;
}

/** Items belonging to one drive that are still worth re-fetching. */
export function retryable_items(ledger: FailedItemLedger, drive_id: string): FailedItemRecord[] {
  return Object.values(ledger).filter(
    (record) => record.drive_id === drive_id && !is_retry_exhausted(record),
  );
}

/** True once an item will no longer be re-fetched, whether by budget or by policy. */
export function is_retry_exhausted(record: FailedItemRecord): boolean {
  return record.permanent === true || record.attempts >= MAX_FAILED_ITEM_ATTEMPTS;
}

/**
 * One operator-facing line per outstanding failure, so a transient blip reads
 * differently from a file that will never back up without intervention.
 *
 * Three states, not two: a policy block is called out separately from a burned
 * attempt budget, because "5 attempts failed" invites the operator to retry
 * while "the service refuses this content" tells them not to bother.
 */
export function describe_failed_items(ledger: FailedItemLedger): string[] {
  return Object.values(ledger).map((record) => {
    const status =
      record.permanent === true
        ? 'PERMANENTLY SKIPPED by service policy, not retried'
        : record.attempts >= MAX_FAILED_ITEM_ATTEMPTS
          ? `PERMANENTLY SKIPPED after ${record.attempts} attempts`
          : `will retry (attempt ${record.attempts} of ${MAX_FAILED_ITEM_ATTEMPTS})`;
    return (
      `Not backed up: ${record.name} (${record.item_id}) -- ${record.reason}; ` +
      `${status}, first failed ${record.first_failed_at}`
    );
  });
}
