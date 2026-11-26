import { Box } from 'ink';
import { logger } from '@wisecom/atlas-core';
import type {
  DriveFolderColorRestoreSummary,
  DriveSharingRestoreSummary,
  OutcomeUnknownFile,
} from '@wisecom/atlas-types';
import {
  EXIT_PARTIAL,
  report_outcome_unknown,
  report_skipped_items,
  report_unmatched_file_filters,
} from '@/command-run-outcome';
import { report_unreadable_keys } from '@/command-unreadable-objects';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import {
  report_sharing_skips,
  sharing_restore_items,
} from '@/commands/drive/sharing-restore-presenter';

/** Shown on the first Ctrl+C of a OneDrive or SharePoint restore or version restore. */
export const DRIVE_RESTORE_INTERRUPT_MESSAGE =
  'Stopping the restore; an upload already sent finishes first, and nothing after it is written';

/** The counts both drive snapshot restores report, permissions and folder colours included. */
export interface DriveRestoreSummary
  extends DriveSharingRestoreSummary, DriveFolderColorRestoreSummary {
  readonly snapshot_id: string;
  readonly files_restored: number;
  readonly folders_created: number;
  readonly files_skipped: number;
  readonly errors: string[];
  /** The files among `errors` whose upload may have committed (issue #893). */
  readonly outcome_unknown: readonly OutcomeUnknownFile[];
  readonly interrupted: boolean;
  /** Damaged manifests the restore skipped because they are newer than the snapshot (issue #631). */
  readonly unreadable_keys?: readonly string[] | undefined;
  /** `--file-filter` values that matched no file while others did (issue #707). */
  readonly unmatched_file_filters?: readonly string[] | undefined;
}

/**
 * Prints what a drive snapshot restore wrote and sets its exit code. A file that failed, a skip,
 * and an interrupt all exit 2, as Outlook restore does (issue #712), and an interrupted run says so
 * instead of reporting success (issue #682). A run that cannot start throws a category exit. A
 * permission or folder colour left out is listed but never changes the exit code.
 */
export async function report_drive_restore(
  title: string,
  result: DriveRestoreSummary,
  extra_items: readonly KeyValueItem[],
): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
      <Banner title={title} />
      <KeyValueList
        items={[
          { label: 'Snapshot', value: result.snapshot_id },
          { label: 'Files restored', value: String(result.files_restored) },
          { label: 'Folders created', value: String(result.folders_created) },
          ...sharing_restore_items(result),
          ...folder_color_restore_items(result),
          ...extra_items,
        ]}
      />
    </Box>,
  );
  report_skipped_items(result.files_skipped, 'File');
  report_sharing_skips(result);
  report_unreadable_keys(result.unreadable_keys);
  report_unmatched_file_filters(result.unmatched_file_filters);
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
    report_outcome_unknown(result.outcome_unknown.length, 'file');
    process.exitCode = EXIT_PARTIAL;
  } else if (result.interrupted) {
    logger.warn(
      `Restore interrupted after ${result.files_restored} file(s) -- exit ${EXIT_PARTIAL}`,
    );
    process.exitCode = EXIT_PARTIAL;
  } else if (!result.unmatched_file_filters?.length) {
    logger.success('Restore completed successfully');
  }
}

/**
 * The summary row for folder colours the restore could not apply. Graph refuses every write to the
 * colour columns, so this is informational and never changes the exit code.
 */
function folder_color_restore_items(summary: DriveFolderColorRestoreSummary): KeyValueItem[] {
  const count = summary.folder_colors_not_restored ?? 0;
  if (count === 0) return [];
  return [
    {
      label: 'Folder colours not restored',
      value: `${count} (not supported by Microsoft Graph, see docs)`,
    },
  ];
}
