/**
 * Restores message 1 of one snapshot into E2E_DESTINATION, a top-level folder named after the
 * run marker, which the mailbox sweep removes at teardown.
 *
 * The only SDK scenario that writes to the mailbox, and it writes one message. Prints counts and
 * the progress events without `current`, never the Graph ids of what was created.
 */

import { create_instance, main, progress_recorder, required_env } from './lib.mjs';

await main(async () => {
  const snapshot = required_env('E2E_SNAPSHOT_ID');
  const destination = required_env('E2E_DESTINATION');
  const progress = progress_recorder();
  const atlas = create_instance();
  try {
    const result = await atlas.outlook.restore(snapshot, {
      messageRef: '1',
      destination,
      onProgress: progress.on_progress,
    });
    return {
      restored_count: result.restoredCount,
      error_count: result.errorCount,
      attachment_error_count: result.attachmentErrorCount,
      reports: result.messages.length,
      attachments_failed: result.messages.reduce((sum, m) => sum + m.attachmentsFailed, 0),
      interrupted: result.interrupted,
      events: progress.events,
    };
  } finally {
    await atlas.dispose();
  }
});
