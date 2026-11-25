import {
  clear_item_failure,
  record_item_failure,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  BackupProgressReporter,
  OneDriveDeltaItem,
  OneDriveDrive,
  OperationControlOptions,
} from '@wisecom/atlas-types';
import type { DeltaItemOutcome } from '@/services/backup/delta-item-processor';
import type {
  DriveScanAccumulators,
  SingleDriveResult,
} from '@/services/backup/backup-drive-processor';

/** Records one item's failure against the run and the ledger it is retried from. */
export function record_item_outcome_failure(
  result: SingleDriveResult,
  failed_item_ids: Set<string>,
  drive_id: string,
  item: OneDriveDeltaItem,
  outcome: DeltaItemOutcome,
): void {
  const reason = outcome.error ?? 'unknown failure';
  logger.warn(`Drive ${drive_id}: ${reason}`);
  result.errors.push(reason);
  failed_item_ids.add(item.item_id);
  result.failed_items = record_item_failure(result.failed_items, {
    item_id: item.item_id,
    drive_id,
    name: item.file_name,
    reason,
    ...(outcome.permanent === true ? { permanent: true } : {}),
    ...(outcome.consumes_attempt === false ? { consumes_attempt: false } : {}),
  });
}

/** Folds one successful item into the drive's running totals and clears its ledger entry. */
export function apply_item_outcome(
  result: SingleDriveResult,
  item: OneDriveDeltaItem,
  outcome: DeltaItemOutcome,
): void {
  result.failed_items = clear_item_failure(result.failed_items, item.item_id);
  result.files_stored += outcome.files_stored;
  result.files_deduplicated += outcome.files_deduplicated;
  result.deleted_items += outcome.deleted_items;
  if (outcome.entry) result.entries.push(outcome.entry);
}

/**
 * Records a drive whose scan threw. A Graph call cut short by cancellation is the run stopping,
 * not the drive failing, so it marks the scan interrupted instead of adding an error; the drive
 * keeps its old delta link either way (issue #673).
 */
export function record_failed_or_cancelled_drive(
  err: unknown,
  drive: OneDriveDrive,
  index: number,
  accumulators: DriveScanAccumulators,
  progress: BackupProgressReporter | undefined,
  control: OperationControlOptions,
): void {
  if (control.abort_signal?.aborted === true) {
    accumulators.interrupted = true;
    progress?.mark_all_pending_interrupted();
    return;
  }
  const reason = err instanceof Error ? err.message : String(err);
  logger.error(`Drive ${drive.drive_id} failed: ${reason}`);
  accumulators.errors.push(`Drive ${drive.drive_name} (${drive.drive_id}): ${reason}`);
  progress?.mark_error(index, reason);
}
