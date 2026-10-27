import type { OneDriveDrive } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveRecrawl } from '@wisecom/atlas-drive/backup/recrawl-tombstones';
import type {
  DriveScanAccumulators,
  SingleDriveResult,
} from '@/services/backup/backup-drive-processor';

/** Folds one drive's outcome into the run accumulators and the delta link map. */
export function accumulate_drive_result(
  accumulators: DriveScanAccumulators,
  delta_link_by_drive: Record<string, string>,
  drive: OneDriveDrive,
  drive_result: SingleDriveResult,
  recrawl: DriveRecrawl | undefined,
): void {
  if (recrawl) accumulators.recrawls.push(recrawl);
  accumulators.entries.push(...drive_result.entries);
  accumulators.files_stored += drive_result.files_stored;
  accumulators.files_deduplicated += drive_result.files_deduplicated;
  accumulators.deleted_items += drive_result.deleted_items;
  accumulators.failed_items = drive_result.failed_items;
  accumulators.interrupted ||= drive_result.interrupted;

  if (!drive_result.interrupted && drive_result.delta_link) {
    delta_link_by_drive[drive.drive_id] = drive_result.delta_link;
  }
  if (drive_result.errors.length > 0) {
    logger.warn(
      `Drive ${drive.drive_id}: ${drive_result.errors.length} item(s) failed; ` +
        `delta advanced and failures recorded for retry`,
    );
  }
}
