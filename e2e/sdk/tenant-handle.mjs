/**
 * `createTenant`: format checks without I/O, a handle that never serialises its secret, and a
 * token request with the credentials it holds.
 *
 * No second tenant exists for the suite, so the handle is built from this tenant's own app
 * registration. Prints booleans and `{ thrown, code, classes }` per refused configuration.
 */

import { capture, capture_sync, main, required_env, sdk } from './lib.mjs';

await main(async () => {
  const config = {
    tenantId: required_env('ATLAS_TENANT_ID'),
    clientId: required_env('ATLAS_CLIENT_ID'),
    clientSecret: required_env('ATLAS_CLIENT_SECRET'),
  };
  const handle = sdk.createTenant(config);
  // Every way a host is likely to print or copy the handle.
  const renderings = [JSON.stringify(handle), JSON.stringify({ ...handle }), String(handle)];

  return {
    tenant_id_kept: handle.tenantId === config.tenantId,
    client_id_kept: handle.clientId === config.clientId,
    secret_rendered: renderings.some((text) => text.includes(config.clientSecret)),
    validate: await capture(() => handle.validate()),
    tenant_id_malformed: capture_sync(() =>
      sdk.createTenant({ ...config, tenantId: 'not-a-tenant' }),
    ),
    client_id_malformed: capture_sync(() =>
      sdk.createTenant({ ...config, clientId: 'not-a-guid' }),
    ),
    secret_with_whitespace: capture_sync(() =>
      sdk.createTenant({ ...config, clientSecret: 'two words' }),
    ),
    no_config: capture_sync(() => sdk.createTenant(undefined)),
  };
});
