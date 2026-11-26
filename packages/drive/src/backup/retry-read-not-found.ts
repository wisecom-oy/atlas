/**
 * What a "not found" answer means when a run re-reads a file from the failed-items list.
 *
 * The list is the only route back for a file that failed while unchanged: the drive's delta link
 * already moved past it, and delta never re-presents an unchanged item. Clearing the entry on one
 * `404` therefore drops the file from every later snapshot, and a `404` is not proof of deletion.
 * Graph answers it during incidents and from replica lag, and `with_graph_retry` never retries one
 * (issue #850).
 *
 * A real deletion is reported by delta as a `deleted` item, which clears the entry in the same run
 * through the normal delta path. This module covers the read alone: the file stays listed, spends
 * none of its attempts, and is cleared only once the answer has repeated on enough consecutive runs
 * across enough time that a passing fault is no longer a credible cause.
 */

import {
  clear_item_failure,
  record_item_failure,
  type FailedItemLedger,
  type FailedItemRecord,
  type NotFoundStreak,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  describe_not_found_streak,
  extend_not_found_streak,
  is_not_found_confirmed,
} from '@wisecom/atlas-core/services/shared/not-found-streak';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Applies a "not found" answer to a listed file's re-read, and logs which way it went: the entry is
 * cleared once the deletion is confirmed, and otherwise kept with the streak extended and no attempt
 * spent.
 */
export function resolve_retry_read_not_found(
  ledger: FailedItemLedger,
  record: FailedItemRecord,
  now: Date = new Date(),
): FailedItemLedger {
  const streak = extend_not_found_streak(record.not_found, now);
  if (is_not_found_confirmed(streak, now)) {
    logger.info(
      `Previously failed item ${record.name} (${record.item_id}) answered "not found" on ` +
        `${streak.reads} runs since ${streak.since}; treating it as deleted`,
    );
    return clear_item_failure(ledger, record.item_id);
  }

  logger.warn(
    `Previously failed item ${record.name} (${record.item_id}) answered "not found"; ` +
      `keeping it on the failed-items list (${describe_not_found_streak(streak, 'deleted')})`,
  );
  return record_item_failure(ledger, {
    item_id: record.item_id,
    drive_id: record.drive_id,
    name: record.name,
    reason: describe_unconfirmed_not_found(streak),
    // A missing answer says nothing about the file's content, so it keeps its attempts.
    consumes_attempt: false,
    not_found: streak,
  });
}

/** The operator-facing reason for a file kept on the list after a "not found" re-read. */
function describe_unconfirmed_not_found(streak: NotFoundStreak): string {
  return `Graph answered "not found" when re-reading the file (${describe_not_found_streak(streak, 'deleted')})`;
}
