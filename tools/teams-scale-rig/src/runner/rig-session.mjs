/**
 * Opens a Teams container against a fake server origin and a filesystem store. Child processes
 * and in-process scenarios both go through here, so they bind the same graph is wired the same way.
 */
import path from 'node:path';
import { create_rig_graph_client } from './graph-client.mjs';
import { create_fs_tenant_context_factory } from './fs-tenant-context.mjs';
import { create_teams_container } from './container.mjs';

/** Directory holding one tenant's objects under a store root. */
export function tenant_store_dir(store_root, tenant_id) {
  return path.join(store_root, encodeURIComponent(tenant_id));
}

/**
 * @param {{url: string, store_root: string, passphrase: string, time_scale: number}} options
 * @returns {{container: object, tenant_factory: object}}
 */
export function open_session({ url, store_root, passphrase, time_scale }) {
  const client = create_rig_graph_client({ target_origin: url });
  const tenant_factory = create_fs_tenant_context_factory({ root: store_root, passphrase });
  const container = create_teams_container({ client, tenant_factory, time_scale });
  return { container, tenant_factory };
}
