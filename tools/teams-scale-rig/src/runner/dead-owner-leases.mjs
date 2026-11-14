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
 * Whether a lease record still blocks other runs: not released and not past its expiry. Mirrors
 * the acquirer in owner-lease-acquirer.ts, which treats released and expired records as free.
 * @param {{released_at?: string, expires_at: string}} record parsed lease JSON
 * @param {number} now_ms the time to compare `expires_at` against
 * @returns {boolean}
 */
export function is_live_lease(record, now_ms) {
  return record.released_at === undefined && Date.parse(record.expires_at) > now_ms;
}

/**
 * Expires every live team lease left in a tenant store by a run that did not release it. Released
 * and already-expired records are left as they are and not returned, so the result is evidence of
 * a lease the resume has to take over. A failed compare-and-swap throws.
 * @param {string} tenant_store_dir the tenant's storage root, as `tenant_store_dir` builds it
 * @param {number} [now_ms] the time that decides which leases are live
 * @returns {Promise<string[]>} keys of the leases that were live and are now expired
 */
export async function expire_dead_team_leases(tenant_store_dir, now_ms = Date.now()) {
  const storage = new FsObjectStorage(tenant_store_dir);
  const keys = (await storage.list(TEAM_META_PREFIX)).filter((key) => key.endsWith('/lease.json'));
  const expired = [];
  for (const key of keys) {
    if (await expire_live_lease(storage, key, now_ms)) expired.push(key);
  }
  return expired;
}

/**
 * Rewrites one live lease with an expiry one second before `now_ms`, conditional on the ETag just
 * read. Returns false without writing when the lease is already released or expired.
 */
async function expire_live_lease(storage, key, now_ms) {
  const { data, etag } = await storage.get_with_etag(key);
  const record = JSON.parse(data.toString('utf-8'));
  if (!is_live_lease(record, now_ms)) return false;
  const expired = { ...record, expires_at: new Date(now_ms - 1000).toISOString() };
  const body = Buffer.from(JSON.stringify(expired), 'utf-8');
  await storage.put(key, body, undefined, undefined, etag, false);
  return true;
}
