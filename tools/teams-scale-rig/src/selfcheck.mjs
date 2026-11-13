/**
 * Plain-node self-check for the rig's pure parts: fixture generation and mutation, rate limiting,
 * paging tokens, reply inlining, and CLI parsing. Needs no network or backup run; the rate limiter
 * reads limits from `@wisecom/atlas-types`, so run `pnpm install` first.
 * Run: node tools/teams-scale-rig/src/selfcheck.mjs
 */
import assert from 'node:assert/strict';
import { derive_seed, create_rng } from './fixture/prng.mjs';
import {
  generate_tenant,
  expected_hosted_downloads,
  NOW_MS,
  DELTA_WINDOW_MS,
  TENANT_ID,
} from './fixture/generate-tenant.mjs';
import { add_reply, delete_root, mutate_for_sync } from './fixture/mutate-tenant.mjs';
import { create_rate_limiter, teams_limits } from './server/rate-limiter.mjs';
import { encode_token, decode_token } from './server/paging.mjs';
import { root_json, INLINE_REPLY_LIMIT } from './server/serialize.mjs';
import { parse_args } from './cli-args.mjs';
import { diff_snapshots, resume_blob_problems } from './runner/convergence.mjs';
import { diff_live_content } from './runner/live-content-diff.mjs';

const checks = [];
function test(name, fn) {
  fn();
  checks.push(name);
}

const roots_of = (tenant) =>
  tenant.teams.flatMap((t) =>
    t.channels.flatMap((c) => c.roots.map((r) => ({ team: t, channel: c, root: r }))),
  );

test('seeds and rng are deterministic', () => {
  assert.equal(derive_seed('a', 1), derive_seed('a', 1));
  assert.notEqual(derive_seed('a', 1), derive_seed('a', 2));
  const a = create_rng(7);
  const b = create_rng(7);
  assert.deepEqual(
    [a.int(0, 99), a.int(0, 99), a.int(0, 99)],
    [b.int(0, 99), b.int(0, 99), b.int(0, 99)],
  );
});

test('generator shape, determinism, and time window', () => {
  const big = generate_tenant({ teams: 10, channels_per_team: 10, seed: 3 });
  assert.equal(big.teams.length, 10);
  assert.equal(
    big.teams.reduce((n, t) => n + t.channels.length, 0),
    100,
  );
  assert.equal(new Set(big.teams.map((t) => t.id)).size, 10);
  const again = generate_tenant({ teams: 10, channels_per_team: 10, seed: 3 });
  assert.deepEqual(
    again.teams.map((t) => t.id),
    big.teams.map((t) => t.id),
  );
  assert.equal(TENANT_ID, '00000000-0000-0000-0000-000000000001');
  const rows = roots_of(big);
  assert.ok(
    rows.some(({ root }) => root.deleted_ms !== undefined),
    'some roots are deleted',
  );
  assert.ok(
    rows.some(({ root }) => root.replies.length > INLINE_REPLY_LIMIT),
    'some threads exceed the inline reply limit',
  );
  assert.ok(
    rows.some(({ root }) => root.modified_ms < NOW_MS - DELTA_WINDOW_MS),
    'some roots fall outside the delta window',
  );
  for (const { root } of rows) {
    if (root.deleted_ms !== undefined)
      assert.deepEqual(root.hosted, [], 'deleted roots carry no hosted content');
    for (const h of root.hosted)
      assert.ok(h.size >= 2048 && h.size <= 12288, 'hosted size in range');
  }
});

test('expected hosted downloads count reachable hosted content only', () => {
  const t = generate_tenant({ teams: 4, channels_per_team: 4, seed: 9, image_ratio: 0.5 });
  let manual = 0;
  for (const { root } of roots_of(t)) {
    if (root.deleted_ms !== undefined) continue;
    manual += root.hosted.length;
    for (const r of root.replies) manual += r.hosted.length;
  }
  assert.equal(expected_hosted_downloads(t), manual);
});

test('add_reply bumps the channel sequence and its root, and keeps expected downloads', () => {
  const t = generate_tenant({ teams: 2, channels_per_team: 2, seed: 4 });
  const { team, channel, root } = roots_of(t).find((r) => r.root.deleted_ms === undefined);
  const before = expected_hosted_downloads(t);
  const seq = channel.seq;
  const replies = root.replies.length;
  add_reply(t, { team_id: team.id, channel_id: channel.id, root_id: root.id });
  assert.equal(channel.seq, seq + 1);
  assert.equal(root.replies.length, replies + 1);
  assert.equal(root.version, channel.seq);
  assert.equal(expected_hosted_downloads(t), before);
});

test('mutate_for_sync changes five distinct roots and keeps expected downloads exact', () => {
  const t = generate_tenant({ teams: 3, channels_per_team: 3, seed: 6 });
  const roots = roots_of(t).map((x) => x.root);
  const versions = new Map(roots.map((r) => [r, r.version]));
  const deleted_before = new Set(roots.filter((r) => r.deleted_ms !== undefined));
  const own = new Map(
    roots.map((r) => [r, r.hosted.length + r.replies.reduce((n, x) => n + x.hosted.length, 0)]),
  );
  const before = expected_hosted_downloads(t);
  const result = mutate_for_sync(t);
  assert.deepEqual(result, { replies: 3, new_images: 3, edits: 1, deletions: 1 });
  assert.equal(roots.filter((r) => r.version !== versions.get(r)).length, 5);
  const deleted = roots.filter((r) => r.deleted_ms !== undefined && !deleted_before.has(r));
  assert.equal(deleted.length, 1);
  assert.equal(expected_hosted_downloads(t), before + result.new_images - own.get(deleted[0]));
});

test("delete_root removes that root's hosted content from the expected set", () => {
  const t = generate_tenant({ teams: 2, channels_per_team: 2, seed: 5, image_ratio: 0.5 });
  const target = roots_of(t).find(
    (r) => r.root.deleted_ms === undefined && r.root.replies.some((x) => x.hosted.length),
  );
  const own =
    target.root.hosted.length + target.root.replies.reduce((n, r) => n + r.hosted.length, 0);
  const before = expected_hosted_downloads(t);
  delete_root(t, {
    team_id: target.team.id,
    channel_id: target.channel.id,
    root_id: target.root.id,
  });
  assert.equal(expected_hosted_downloads(t), before - own);
  assert.ok(target.root.deleted_ms !== undefined);
});

test('rate limiter bursts to the tenant bucket, 429s with Retry-After, and refills', () => {
  const limiter = create_rate_limiter({
    tenant_messages_rps: 3,
    channel_messages_rps: 100,
    tenant_default_rps: 100,
    team_default_rps: 100,
  });
  const req = { cls: 'messages', team: 't1', channel: 'c1' };
  const admitted = [0, 1, 2].map(() => limiter.admit({ ...req, now_ms: 0 }).ok);
  assert.deepEqual(admitted, [true, true, true]);
  const denied = limiter.admit({ ...req, now_ms: 0 });
  assert.equal(denied.ok, false);
  assert.ok(Number.isInteger(denied.retry_after_s) && denied.retry_after_s >= 1);
  assert.equal(limiter.admit({ ...req, now_ms: 1000 }).ok, true, 'bucket refills after a second');
});

test('time scale multiplies the Graph budgets', () => {
  assert.equal(teams_limits(10).tenant_messages_rps, teams_limits(1).tenant_messages_rps * 10);
});

test('paging tokens round-trip and tolerate garbage', () => {
  assert.deepEqual(decode_token(encode_token({ o: 50, at: 7 })), { o: 50, at: 7 });
  assert.deepEqual(decode_token('%%%not-a-token'), {});
});

test('root_json inlines up to the limit and links the rest', () => {
  const t = generate_tenant({
    teams: 1,
    channels_per_team: 1,
    seed: 6,
    long_thread_ratio: 1,
    long_thread_replies: [15, 20],
  });
  const { team, channel, root } = roots_of(t)[0];
  const json = root_json(root, team, channel, TENANT_ID);
  assert.equal(json.replies.length, INLINE_REPLY_LIMIT);
  assert.match(json['replies@odata.nextLink'], /\$skiptoken=/);
  const short = { ...root, replies: root.replies.slice(0, 3) };
  const small = root_json(short, team, channel, TENANT_ID);
  assert.equal(small.replies.length, 3);
  assert.equal(small['replies@odata.nextLink'], undefined);
});

test('CLI parsing applies defaults and rejects bad input', () => {
  const opts = parse_args(['sync', '--time-scale', '10', '--teams', '5']);
  assert.equal(opts.scenario, 'sync');
  assert.equal(opts.time_scale, 10);
  assert.equal(opts.teams, 5);
  assert.equal(opts.channels_per_team, 10);
  assert.throws(() => parse_args(['nope']), /unknown scenario/);
  assert.throws(() => parse_args(['sync', '--concurrency', '99']), /1\.\.16/);
  assert.throws(() => parse_args(['sync', '--bogus', '1']), /unknown option/);
});

test('diff_snapshots converges on equal snapshots and flags missing or changed teams', () => {
  const snap = { channels: [{ channel_id: 'a', messages: 1 }] };
  assert.deepEqual(diff_snapshots({ t1: snap }, { t1: structuredClone(snap) }), []);
  assert.equal(diff_snapshots({ t1: null }, { t1: null }).length, 1);
  assert.equal(diff_snapshots({ t1: snap }, { t1: null }).length, 1);
  const changed = { channels: [{ channel_id: 'a', messages: 2 }] };
  const problems = diff_snapshots({ t1: snap }, { t1: changed });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 channel\(s\) differ, first a/);
});

test('diff_live_content compares live threads exactly and tolerates deleted roots', () => {
  const ref = (last_modified_at, deleted_at = null) => ({
    last_modified_at,
    deleted_at,
    hosted: {},
    hosted_missing: [],
  });
  const thread = (root_id, { deleted, replies = {} } = {}) => ({
    root_id,
    deleted_at: deleted ?? null,
    root: ref('t1', deleted ?? null),
    replies: Object.entries(replies).map(([id, r]) => ({ id, ...r })),
  });
  const snap = (threads) => ({ channels: [{ channel_id: 'c', deleted_at: null, threads }] });
  const live = snap([thread('r1', { replies: { x: ref('t2') } })]);
  assert.deepEqual(diff_live_content({ t1: live }, { t1: structuredClone(live) }), []);
  const want_dead = snap([thread('r2', { deleted: '2026-06-01T00:00:00.000Z' })]);
  const got_dead = snap([
    thread('r2', { deleted: '2026-11-04T14:31:53.829Z', replies: { y: ref('t3') } }),
  ]);
  assert.deepEqual(diff_live_content({ t1: want_dead }, { t1: got_dead }), []);
  const got_live = snap([thread('r2')]);
  assert.match(
    diff_live_content({ t1: want_dead }, { t1: got_live })[0],
    /r2 deleted on expected side only/,
  );
  const got_changed = snap([thread('r1', { replies: { x: ref('t9') } })]);
  assert.match(
    diff_live_content({ t1: live }, { t1: got_changed })[0],
    /first c: thread r1 expected/,
  );
  assert.equal(diff_live_content({ t1: live }, { t1: null }).length, 1);
});

test('resume_blob_problems flags blobs downloaded again that the store held at the kill', () => {
  const hosted_keys = new Map([
    ['id1', 'k1'],
    ['id2', 'k2'],
    ['id3', 'k3'],
  ]);
  const reuse = resume_blob_problems({
    keys_at_kill: new Set(['k1']),
    served_ids: new Set(['id1', 'id9']),
    hosted_keys,
  });
  assert.deepEqual(reuse.reused, ['k1']);
  assert.deepEqual(reuse.unmapped, ['id9']);
  assert.deepEqual(reuse.unaccounted, ['k2', 'k3']);

  const again = resume_blob_problems({
    keys_at_kill: new Set(['k2']),
    served_ids: new Set(['id2', 'id3']),
    hosted_keys,
  });
  assert.deepEqual(again.reused, ['k2']);
  assert.deepEqual(again.unaccounted, ['k1']);

  const clean = resume_blob_problems({
    keys_at_kill: new Set(['k1']),
    served_ids: new Set(['id2', 'id3']),
    hosted_keys,
  });
  assert.deepEqual(clean, { reused: [], unaccounted: [], unmapped: [] });
});

console.log(`selfcheck: ${checks.length} checks passed`);
