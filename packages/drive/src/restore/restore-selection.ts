import type { DriveManifestEntry } from '@/drive-ports';
import {
  restorable_entries,
  restorable_item_metadata_entries,
  type DriveChainEntryRow,
} from '@/shared/manifest-chain';
import { select_drive_entries } from '@/shared/entry-filter';
import { is_file_entry } from '@/shared/entry-kind';

/** What a restore writes, split by kind, and the filter values that matched nothing. */
export interface DriveRestoreSelection {
  /** Every selected entry, for routing decisions that span the whole restore. */
  readonly entries: DriveManifestEntry[];
  readonly files: DriveManifestEntry[];
  /** Folder entries, restored after the files. */
  readonly item_metadata: DriveManifestEntry[];
  readonly unmatched_filters: string[];
}

/**
 * Selects what a restore writes from a folded chain. The file filter applies to files and folder
 * entries alike. A rename targets one file, so folder sharing around it is left out.
 *
 * @throws NotFoundError when the filter matched nothing at all.
 */
export function select_restore_entries(
  rows: readonly DriveChainEntryRow[],
  file_filter: string[] | undefined,
  rename_to: string | undefined,
): DriveRestoreSelection {
  const selection = select_drive_entries(
    [...restorable_entries(rows), ...restorable_item_metadata_entries(rows)],
    file_filter,
  );
  const files = selection.entries.filter((entry) => is_file_entry(entry));
  const item_metadata =
    rename_to === undefined ? selection.entries.filter((entry) => !is_file_entry(entry)) : [];
  return {
    entries: selection.entries,
    files,
    item_metadata,
    unmatched_filters: selection.unmatched_filters,
  };
}
