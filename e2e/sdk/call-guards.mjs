/**
 * Restore options the SDK refuses before it reads storage or calls Graph.
 *
 * The instance records every S3 request, so `storage_requests` proves the refusals happened
 * before the storage path was touched. Nothing here can write to the mailbox: every call is
 * refused at the boundary. Prints `{ case: { thrown, code, classes }, storage_requests }`.
 */

import { capture, create_instance, main, required_env, sdk, storage_recorder } from './lib.mjs';

await main(async () => {
  const snapshot = required_env('E2E_SNAPSHOT_ID');
  const mailbox = required_env('E2E_MAILBOX');
  const storage = storage_recorder();
  const atlas = create_instance({ onStorageRequest: storage.on_storage_request });
  // Built from this tenant's own credentials. No restore below gets far enough to use it.
  const handle = sdk.createTenant({
    tenantId: required_env('ATLAS_TENANT_ID'),
    clientId: required_env('ATLAS_CLIENT_ID'),
    clientSecret: required_env('ATLAS_CLIENT_SECRET'),
  });
  try {
    return {
      blank_message_ref: await capture(() =>
        atlas.outlook.restore(snapshot, { messageRef: '   ' }),
      ),
      message_ref_for_a_mailbox: await capture(() =>
        atlas.outlook.restoreMailbox(mailbox, { messageRef: '1' }),
      ),
      target_tenant_without_target: await capture(() =>
        atlas.outlook.restore(snapshot, { targetTenant: handle }),
      ),
      target_tenant_not_a_handle: await capture(() =>
        atlas.outlook.restore(snapshot, { targetTenant: {}, targetMailbox: mailbox }),
      ),
      storage_requests: storage.events.length,
    };
  } finally {
    await atlas.dispose();
  }
});
