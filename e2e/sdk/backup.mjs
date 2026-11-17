/**
 * An Outlook backup of the run's fixture folder, with progress observed.
 *
 * `folderFilter: [marker]` is mandatory, as for the CLI: an unscoped run reads the whole mailbox.
 * With E2E_ABORT_ON set to a phase, the signal is aborted from inside the progress callback when
 * that phase is first seen, which stops the run at a deterministic point. Prints the progress
 * events without `current`, the result's flags and counters, and the reported snapshot id.
 */

import { create_instance, main, progress_recorder, required_env } from './lib.mjs';

await main(async () => {
  const mailbox = required_env('E2E_MAILBOX');
  const marker = required_env('E2E_RUN_MARKER');
  const abort_on = process.env.E2E_ABORT_ON ?? '';
  const controller = new AbortController();
  const progress = progress_recorder((event) => {
    if (event.phase === abort_on) controller.abort();
  });
  const atlas = create_instance();
  try {
    const result = await atlas.outlook.backup(mailbox, {
      folderFilter: [marker],
      signal: controller.signal,
      onProgress: progress.on_progress,
    });
    const { summary } = result;
    return {
      events: progress.events,
      interrupted: result.interrupted,
      snapshot_stored: result.snapshotStored,
      snapshot_id: result.snapshot.id,
      mode: result.mode,
      stored: summary.stored,
      deduplicated: summary.deduplicated,
      processed: summary.processed,
      folder_errors: summary.folderErrors.length,
      completed_folder_count: summary.completedFolderCount,
      total_folder_count: summary.totalFolderCount,
      graph_cost_reported: result.graphCost !== undefined,
    };
  } finally {
    await atlas.dispose();
  }
});
