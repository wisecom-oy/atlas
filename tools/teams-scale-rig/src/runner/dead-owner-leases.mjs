/**
 * Lease handling for a killed backup child. SIGKILL stops the child before it releases its lease,
 * so the lease stays live until its `expires_at`, at most five minutes after its last renewal
 * (owner-lease-timing.ts). An operator waits that out before retrying (docs/teams-backup.md). The
 * rig does not wait five minutes per run, so it moves each dead lease's expiry into the past,
 * which is the state the TTL reaches. The resumed run then takes the lease over through the real
 * takeover path, a compare-and-swap on the stored ETag, not by deleting the object.
 */
import { FsObjectStorage } from './fs-object-storage.mjs';

/** Where a team's lease sits in the tenant store: `teams/_meta/<team>/lease.json`. */
const TEAM_META_PREFIX = 'teams/_meta/';

/**
 * Expires every team lease left in a tenant store by a run that did not release it.
 * @param {string} tenant_store_dir the tenant's storage root, as `tenant_store_dir` builds it
 * @returns {Promise<string[]>} keys of the leases that were expired, empty when none were live
 */
export async function expire_dead_team_leases(tenant_store_dir) {
  const storage = new FsObjectStorage(tenant_store_dir);
  const keys = (await storage.list(TEAM_META_PREFIX)).filter((key) => key.endsWith('/lease.json'));
  for (const key of keys) await expire_lease(storage, key);
  return keys;
}

/** Rewrites one lease with an expiry one second in the past, conditional on the ETag just read. */
async function expire_lease(storage, key) {
  const { data, etag } = await storage.get_with_etag(key);
  const record = JSON.parse(data.toString('utf-8'));
  const expired = { ...record, expires_at: new Date(Date.now() - 1000).toISOString() };
  const body = Buffer.from(JSON.stringify(expired), 'utf-8');
  await storage.put(key, body, undefined, undefined, etag, false);
}
