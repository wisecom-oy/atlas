import { Box } from 'ink';
import { logger } from '@wisecom/atlas-core';
import { EXIT_PARTIAL, report_skipped_items } from '@/command-run-outcome';
import { Banner } from '@/ui/components/banner';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

/** Shown on the first Ctrl+C of a OneDrive or SharePoint restore or version restore. */
export const DRIVE_RESTORE_INTERRUPT_MESSAGE =
  'Stopping the restore; an upload already sent finishes first, and nothing after it is written';

/** The counts both drive snapshot restores report. */
export interface DriveRestoreSummary {
  readonly snapshot_id: string;
  readonly files_restored: number;
  readonly folders_created: number;
  readonly files_skipped: number;
  readonly errors: string[];
  readonly interrupted: boolean;
}

/**
 * Prints what a drive snapshot restore wrote and sets its exit code: errors exit 1, skips and an
 * interrupt exit 2, and an interrupted run says so instead of reporting success (issue #682).
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
          ...extra_items,
        ]}
      />
    </Box>,
  );
  report_skipped_items(result.files_skipped, 'File');
  if (result.errors.length > 0) {
    await render_static_view(<ErrorList errors={result.errors} max={result.errors.length} />);
    process.exitCode = 1;
  } else if (result.interrupted) {
    logger.warn(
      `Restore interrupted after ${result.files_restored} file(s) -- exit ${EXIT_PARTIAL}`,
    );
    process.exitCode = EXIT_PARTIAL;
  } else {
    logger.success('Restore completed successfully');
  }
}
