/**
 * Storage request events of one read-only operation: a fast verify of an existing snapshot.
 *
 * Prints the events as Atlas emitted them. By contract they hold no object key, bucket, endpoint
 * or identifier; the Python side checks that, and the field types, against the settings it holds.
 */

import { create_instance, main, required_env, storage_recorder } from './lib.mjs';

await main(async () => {
  const snapshot = required_env('E2E_SNAPSHOT_ID');
  const storage = storage_recorder();
  const atlas = create_instance({ onStorageRequest: storage.on_storage_request });
  try {
    const report = await atlas.outlook.verify(snapshot, { fast: true });
    return {
      verify: {
        total_checked: report.totalChecked,
        passed: report.passed,
        failed: report.failed.length,
      },
      events: storage.events,
    };
  } finally {
    await atlas.dispose();
  }
});
