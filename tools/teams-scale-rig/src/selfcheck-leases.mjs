/**
 * Self-check cases for the dead-lease handling kill-resume relies on. Runs against a temporary
 * directory store, so it needs no network or backup run. Imported by selfcheck.mjs.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsObjectStorage } from './runner/fs-object-storage.mjs';
import { expire_dead_team_leases, is_live_lease } from './runner/dead-owner-leases.mjs';

const NOW_MS = Date.parse('2026-01-01T12:00:00.000Z');
const iso = (offset_ms) => new Date(NOW_MS + offset_ms).toISOString();

/** A lease record in the stored JSON shape, live by default. */
function lease_record(team, fields = {}) {
  return {
    format_version: 1,
    holder_id: `holder-${team}`,
    operation: 'backup',
    acquired_at: iso(-60_000),
    expires_at: iso(240_000),
    ...fields,
  };
}

async function put_json(storage, key, value) {
  await storage.put(key, Buffer.from(JSON.stringify(value), 'utf-8'));
}

async function read_json(storage, key) {
  return JSON.parse((await storage.get(key)).toString('utf-8'));
}

/**
 * Runs the lease cases and returns their names.
 * @returns {Promise<string[]>}
 */
export async function run_lease_checks() {
  const names = [];

  assert.equal(is_live_lease(lease_record('a'), NOW_MS), true);
  assert.equal(is_live_lease(lease_record('a', { expires_at: iso(-1) }), NOW_MS), false);
  assert.equal(is_live_lease(lease_record('a', { released_at: iso(-1) }), NOW_MS), false);
  names.push('is_live_lease treats released and expired records as free');

  const dir = await mkdtemp(join(tmpdir(), 'rig-leases-'));
  try {
    const storage = new FsObjectStorage(dir);
    const live = 'teams/_meta/team-live/lease.json';
    const released = 'teams/_meta/team-released/lease.json';
    const stale = 'teams/_meta/team-stale/lease.json';
    await put_json(storage, live, lease_record('live'));
    await put_json(storage, released, lease_record('released', { released_at: iso(-5_000) }));
    await put_json(storage, stale, lease_record('stale', { expires_at: iso(-5_000) }));
    await put_json(storage, 'teams/_meta/team-live/index.json', { not: 'a lease' });
    const released_before = await storage.get(released);
    const stale_before = await storage.get(stale);

    const expired = await expire_dead_team_leases(dir, NOW_MS);

    assert.deepEqual(expired, [live]);
    const after = await read_json(storage, live);
    assert.equal(after.expires_at, iso(-1000));
    assert.equal(after.holder_id, 'holder-live');
    assert.equal(is_live_lease(after, NOW_MS), false);
    assert.deepEqual(await storage.get(released), released_before);
    assert.deepEqual(await storage.get(stale), stale_before);
    names.push('expire_dead_team_leases expires and returns only live leases');

    assert.deepEqual(await expire_dead_team_leases(dir, NOW_MS), []);
    names.push('expire_dead_team_leases returns nothing once no lease is live');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return names;
}
