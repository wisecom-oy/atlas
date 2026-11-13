/**
 * Builds the synthetic Teams tenant the fake Graph server serves.
 *
 * Everything is derived from one seed, so a child process regenerates the same tenant from the
 * same flags. Bodies, hosted image bytes, and user names are computed on demand from per-object
 * seeds, which keeps the model small enough for ~200k messages.
 */
import { create_rng, derive_seed, synthetic_guid } from './prng.mjs';

// A GUID, because Teams backup refuses any other tenant form (#723).
export const TENANT_ID = '00000000-0000-0000-0000-000000000001';
/** Fixed reference instant. The fixture never reads the wall clock. */
export const NOW_MS = Date.parse('2026-06-01T00:00:00.000Z');
const DAY_MS = 86_400_000;
/** Delta covers roughly the last eight months of activity, mirroring Graph's window. */
export const DELTA_WINDOW_MS = 240 * DAY_MS;

export const DEFAULT_SHAPE = Object.freeze({
  seed: 586,
  teams: 100,
  channels_per_team: 10,
  roots_per_channel: 30,
  members_per_team: 8,
  long_thread_ratio: 0.1,
  long_thread_replies: [15, 60],
  short_replies_max: 6,
  image_ratio: 0.05,
  deleted_ratio: 0.03,
  files_missing_ratio: 0.03,
});

/**
 * Generates the tenant model.
 * @param {Partial<typeof DEFAULT_SHAPE>} [options]
 */
export function generate_tenant(options = {}) {
  const shape = { ...DEFAULT_SHAPE, ...options };
  const rng = create_rng(derive_seed('tenant', shape.seed));
  const tenant = {
    tenant_id: TENANT_ID,
    shape,
    seq: 0,
    teams: [],
    team_by_id: new Map(),
  };
  for (let t = 0; t < shape.teams; t++) {
    const team = build_team(tenant, rng, t);
    tenant.teams.push(team);
    tenant.team_by_id.set(team.id, team);
  }
  return tenant;
}

/** Builds one team with its members and channels. */
function build_team(tenant, rng, t) {
  const team = {
    id: synthetic_guid(1, t + 1),
    display_name: `Rig team ${t}`,
    members: [],
    channels: [],
    channel_by_id: new Map(),
  };
  const member_count = rng.int(4, 12);
  for (let m = 0; m < member_count; m++) {
    team.members.push({
      id: synthetic_guid(2, t * 100 + m + 1),
      display_name: `Rig user ${t}-${m}`,
    });
  }
  for (let c = 0; c < tenant.shape.channels_per_team; c++) {
    const channel = build_channel(tenant, rng, team, t, c);
    team.channels.push(channel);
    team.channel_by_id.set(channel.id, channel);
  }
  return team;
}

/** Builds one channel with its roots, replies, tabs, and filesFolder mode. */
function build_channel(tenant, rng, team, t, c) {
  const roll = rng.next();
  const files_mode = roll < tenant.shape.files_missing_ratio ? 'missing' : 'ok';
  const channel = {
    id: `19:rig-${t}-${c}@thread.tacv2`,
    display_name: `Rig channel ${t}-${c}`,
    files_mode: c === 1 && t === 0 ? 'forbidden' : files_mode,
    tabs: [{ id: `tab-${t}-${c}`, display_name: 'Rig tab' }],
    roots: [],
    root_by_id: new Map(),
    members: team.members.slice(0, rng.int(2, team.members.length)),
    seq: 0,
    email: `rig-${t}-${c}@teams.invalid`,
  };
  for (let r = 0; r < tenant.shape.roots_per_channel; r++) {
    const root = build_root(tenant, rng, team, channel);
    channel.roots.push(root);
    channel.root_by_id.set(root.id, root);
  }
  return channel;
}

/** Builds one root message with its replies and hosted images. */
function build_root(tenant, rng, team, channel) {
  const shape = tenant.shape;
  tenant.seq += 1;
  const seq = tenant.seq;
  const created_ms = NOW_MS - rng.int(0, 36 * 30) * DAY_MS - rng.int(0, DAY_MS);
  const root = {
    id: String(1_700_000_000_000 + seq),
    seq,
    from: team.members[rng.int(0, team.members.length - 1)],
    created_ms,
    modified_ms: created_ms,
    version: ++channel.seq,
    deleted_version: 0,
    deleted_ms: undefined,
    text_seed: derive_seed('root', seq),
    hosted: rng.chance(shape.image_ratio) ? [build_hosted(seq, 0, rng)] : [],
    replies: [],
  };
  const long = rng.chance(shape.long_thread_ratio);
  const reply_count = long
    ? rng.int(shape.long_thread_replies[0], shape.long_thread_replies[1])
    : rng.int(0, shape.short_replies_max);
  let cursor_ms = created_ms;
  for (let k = 0; k < reply_count; k++) {
    cursor_ms = Math.min(NOW_MS, cursor_ms + rng.int(1, 6 * 3_600_000));
    root.replies.push(build_reply(tenant, rng, team, cursor_ms));
  }
  if (root.replies.length > 0) {
    root.modified_ms = Math.max(created_ms, root.replies[root.replies.length - 1].created_ms);
  }
  if (rng.chance(shape.deleted_ratio)) {
    root.deleted_ms = Math.min(NOW_MS, root.modified_ms + DAY_MS);
    root.deleted_version = ++channel.seq;
    root.replies = [];
    root.hosted = [];
  }
  return root;
}

/** Builds one reply at the given creation instant. */
function build_reply(tenant, rng, team, created_ms) {
  tenant.seq += 1;
  const seq = tenant.seq;
  return {
    id: String(1_800_000_000_000 + seq),
    created_ms,
    from: team.members[rng.int(0, team.members.length - 1)],
    text_seed: derive_seed('reply', seq),
    hosted: rng.chance(tenant.shape.image_ratio) ? [build_hosted(seq, 1, rng)] : [],
  };
}

/** Hosted image metadata. Bytes are generated on demand from `seed`. */
export function build_hosted(seq, kind, rng) {
  return {
    id: `hc-${seq}-${kind}`,
    seed: derive_seed('hosted', seq, kind),
    size: rng.int(2048, 12288),
    content_type: 'image/png',
  };
}

/**
 * Counts what a full, non-deleted sync must download: every hosted image reachable from a
 * non-deleted root or reply.
 * @param {ReturnType<typeof generate_tenant>} tenant
 */
/** @param {ReturnType<typeof generate_tenant>} tenant */
export function expected_hosted_downloads(tenant) {
  let total = 0;
  for (const team of tenant.teams) {
    for (const channel of team.channels) {
      for (const root of channel.roots) {
        if (root.deleted_ms !== undefined) continue;
        total += root.hosted.length;
        for (const reply of root.replies) total += reply.hosted.length;
      }
    }
  }
  return total;
}
