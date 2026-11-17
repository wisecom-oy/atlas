/**
 * A passphrase that does not open the tenant's data key surfaces as `ATLAS_WRONG_PASSPHRASE`.
 *
 * The listing addresses the mailbox by its object id, so no identity lookup runs and nothing can
 * be registered under the wrong key. Both calls only read. The correct passphrase is validated
 * too, so a failure of the first two cannot be blamed on storage or Graph being unreachable.
 */

import { capture, create_instance, main, required_env } from './lib.mjs';

await main(async () => {
  const owner = required_env('E2E_OWNER_ID');
  const wrong = create_instance({ encryptionPassphrase: required_env('E2E_WRONG_PASSPHRASE') });
  const right = create_instance();
  try {
    return {
      validate_wrong: await capture(() => wrong.validate()),
      listing_wrong: await capture(() => wrong.outlook.listSnapshotSummaries(owner)),
      validate_right: await capture(() => right.validate()),
    };
  } finally {
    await wrong.dispose();
    await right.dispose();
  }
});
