/**
 * Instance configuration the SDK must refuse at construction, before any network request.
 *
 * Each case is one field wrong and everything else valid, so the refusal can only come from that
 * field. Prints `{ case: { thrown, code, classes } }`.
 */

import { capture_sync, instance_config, main, sdk } from './lib.mjs';

/** One byte below the 14-byte minimum the docs and `MIN_PASSPHRASE_BYTES` set. */
const SHORT_PASSPHRASE = 'x'.repeat(13);

await main(async () => {
  const construct = (overrides) => () => sdk.createAtlasInstance(instance_config(overrides));
  return {
    blank_tenant: capture_sync(construct({ tenantId: '   ' })),
    endpoint_not_a_url: capture_sync(construct({ s3Endpoint: 'not a url' })),
    endpoint_not_http: capture_sync(construct({ s3Endpoint: 'ftp://127.0.0.1:9000' })),
    short_passphrase: capture_sync(construct({ encryptionPassphrase: SHORT_PASSPHRASE })),
    observer_not_a_function: capture_sync(construct({ onStorageRequest: 'not a function' })),
    pacing_share_out_of_range: capture_sync(construct({ teamsPacingShare: 2 })),
  };
});
