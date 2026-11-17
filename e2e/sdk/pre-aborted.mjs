/**
 * A verify and a backup started with a signal that is already aborted.
 *
 * Both must resolve, not reject, with `interrupted: true`, emit only `finalizing` then
 * `interrupted`, and send no S3 request. The backup addresses the mailbox by object id, so no
 * identity lookup reads the registry first, and it is scoped to the run's fixture folder in case
 * the abort were ignored. Prints phases, counts and flags.
 */

import {
  create_instance,
  main,
  progress_recorder,
  required_env,
  storage_recorder,
} from './lib.mjs';

await main(async () => {
  const owner = required_env('E2E_OWNER_ID');
  const snapshot = required_env('E2E_SNAPSHOT_ID');
  const marker = required_env('E2E_RUN_MARKER');
  const storage = storage_recorder();
  const atlas = create_instance({ onStorageRequest: storage.on_storage_request });
  const aborted = AbortSignal.abort();
  try {
    const verify_progress = progress_recorder();
    const verify = await atlas.outlook.verify(snapshot, {
      signal: aborted,
      onProgress: verify_progress.on_progress,
    });
    const verify_requests = storage.events.length;

    const backup_progress = progress_recorder();
    const backup = await atlas.outlook.backup(owner, {
      folderFilter: [marker],
      signal: aborted,
      onProgress: backup_progress.on_progress,
    });

    return {
      verify: {
        interrupted: verify.interrupted,
        total_checked: verify.totalChecked,
        phases: verify_progress.events.map((event) => event.phase),
        storage_requests: verify_requests,
      },
      backup: {
        interrupted: backup.interrupted,
        snapshot_stored: backup.snapshotStored,
        stored: backup.summary.stored,
        phases: backup_progress.events.map((event) => event.phase),
        storage_requests: storage.events.length - verify_requests,
      },
    };
  } finally {
    await atlas.dispose();
  }
});
