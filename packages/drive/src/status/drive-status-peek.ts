import { AuthError, type FailedItemLedger } from '@wisecom/atlas-types';
import { is_missing_graph_permissions } from '@wisecom/atlas-m365-graph';
import {
  describe_peek_error,
  rethrow_if_peek_fatal,
} from '@wisecom/atlas-core/services/shared/status-peek-error';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveDeltaItem, DriveStatus } from '@/drive-ports';
import { resolve_backed_up_kind } from '@/backup/backed-up-item-kind';

/** A drive or document library to report on. */
export interface DriveStatusTarget {
  readonly drive_id: string;
  readonly drive_name: string;
}

/** What a drive status peek reads: the provider's drives, its saved cursor, and its delta call. */
export interface DriveStatusPeekInput {
  readonly drives: readonly DriveStatusTarget[];
  readonly delta_link_by_drive: Readonly<Record<string, string>>;
  readonly previous_kind_by_file_id: Readonly<Record<string, 'file' | 'folder'>>;
  readonly failed_items: FailedItemLedger;
  /** Walks a drive's delta from the saved link without persisting the advanced one. */
  readonly fetch_delta: (
    drive_id: string,
    delta_link: string,
  ) => Promise<{ readonly items: readonly DriveDeltaItem[] }>;
  /** `drive` or `library`, for the warning a failed peek logs. */
  readonly item_label: string;
}

/** The totals a drive status result reports over its rows and the whole failed-item ledger. */
export interface DriveStatusSummary {
  readonly is_up_to_date: boolean;
  readonly total_pending_changes: number;
  readonly total_failed_items: number;
}

/** Counts ledger entries per drive id. */
export function count_failed_items_by_drive(ledger: FailedItemLedger): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of Object.values(ledger)) {
    counts.set(record.drive_id, (counts.get(record.drive_id) ?? 0) + 1);
  }
  return counts;
}

/** Counts the delta items a backup would act on: files, live or deleted, never folders. */
export function count_pending_file_changes(
  items: readonly DriveDeltaItem[],
  previous_kind_by_file_id: Readonly<Record<string, 'file' | 'folder'>>,
): number {
  return items.filter((item) => resolve_backed_up_kind(item, previous_kind_by_file_id) === 'file')
    .length;
}

/**
 * Builds one status row per drive. A drive is up to date only when its delta holds no file change,
 * its peek succeeded, and no file of it waits in the failed-item ledger.
 */
export async function peek_drive_statuses(input: DriveStatusPeekInput): Promise<DriveStatus[]> {
  const failed_by_drive = count_failed_items_by_drive(input.failed_items);
  const rows: DriveStatus[] = [];
  for (const drive of input.drives) {
    const failed_items = failed_by_drive.get(drive.drive_id) ?? 0;
    const delta_link = input.delta_link_by_drive[drive.drive_id];
    rows.push(
      delta_link
        ? await peek_one_drive(input, drive, delta_link, failed_items)
        : {
            drive_id: drive.drive_id,
            drive_name: drive.drive_name,
            has_backup: false,
            pending_changes: 0,
            failed_items,
            is_up_to_date: false,
          },
    );
  }
  return rows;
}

/** Totals the rows. Ledger entries for a drive that no longer exists still count. */
export function summarize_drive_statuses(
  rows: readonly DriveStatus[],
  failed_items: FailedItemLedger,
): DriveStatusSummary {
  const total_failed_items = Object.keys(failed_items).length;
  return {
    is_up_to_date: rows.every((row) => row.is_up_to_date) && total_failed_items === 0,
    total_pending_changes: rows.reduce((sum, row) => sum + row.pending_changes, 0),
    total_failed_items,
  };
}

/**
 * Rethrows a peek failure that applies to every drive. The drive connectors report a Graph 403 on
 * enumeration as `MissingGraphPermissionsError`, which carries neither a status nor an Atlas code,
 * so it is promoted to the `AuthError` the CLI maps to exit code 4.
 */
function rethrow_if_drive_peek_fatal(err: unknown): void {
  if (is_missing_graph_permissions(err)) throw new AuthError(err.message, { cause: err });
  rethrow_if_peek_fatal(err);
}

/**
 * Peeks one drive, rethrowing a failure no other drive can escape and recording any other on the
 * row, so a Graph error reads as an error rather than as pending changes.
 */
async function peek_one_drive(
  input: DriveStatusPeekInput,
  drive: DriveStatusTarget,
  delta_link: string,
  failed_items: number,
): Promise<DriveStatus> {
  const row = { drive_id: drive.drive_id, drive_name: drive.drive_name, has_backup: true };
  try {
    const { items } = await input.fetch_delta(drive.drive_id, delta_link);
    const pending_changes = count_pending_file_changes(items, input.previous_kind_by_file_id);
    return {
      ...row,
      pending_changes,
      failed_items,
      is_up_to_date: pending_changes === 0 && failed_items === 0,
    };
  } catch (err) {
    rethrow_if_drive_peek_fatal(err);
    const peek_error = describe_peek_error(err);
    logger.warn(`Status peek failed for ${input.item_label} ${drive.drive_name}: ${peek_error}`);
    return { ...row, pending_changes: 0, failed_items, is_up_to_date: false, peek_error };
  }
}
