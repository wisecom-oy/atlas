/**
 * Calls that name something that does not exist, each expected to reject with a typed error.
 *
 * The restores carry a destination inside the run's namespace, so if one ever got as far as
 * creating its folder, the mailbox sweep would still remove it and the Python side would see it.
 * The backup is scoped to the fixture folder for the same reason. Prints
 * `{ case: { thrown, code, classes } }`.
 */

import { capture, create_instance, main, required_env } from './lib.mjs';

await main(async () => {
  const marker = required_env('E2E_RUN_MARKER');
  const snapshot = required_env('E2E_SNAPSHOT_ID');
  const unknown_snapshot = required_env('E2E_UNKNOWN_SNAPSHOT');
  const unknown_owner = required_env('E2E_UNKNOWN_OWNER');
  const destination = required_env('E2E_DESTINATION');
  const atlas = create_instance();
  try {
    return {
      verify_unknown_snapshot: await capture(() => atlas.outlook.verify(unknown_snapshot)),
      restore_unknown_snapshot: await capture(() =>
        atlas.outlook.restore(unknown_snapshot, { destination }),
      ),
      restore_unknown_message: await capture(() =>
        atlas.outlook.restore(snapshot, { messageRef: '99999', destination }),
      ),
      backup_unknown_mailbox: await capture(() =>
        atlas.outlook.backup(unknown_owner, { folderFilter: [marker] }),
      ),
      list_unknown_address: await capture(() =>
        atlas.outlook.listSnapshots(`${marker}-nobody@example.com`),
      ),
    };
  } finally {
    await atlas.dispose();
  }
});
