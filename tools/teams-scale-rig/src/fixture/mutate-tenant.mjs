/**
 * Mutations applied between runs to exercise delta sync. Each one advances the affected channel's
 * change sequence and stamps the changed root with it, so the next delta read returns that root.
 * A reply change bumps its root, mirroring Graph, where the root's lastModifiedDateTime moves.
 */
import { build_hosted, NOW_MS } from './generate-tenant.mjs';
import { create_rng, derive_seed } from './prng.mjs';

/**
 * Appends a reply to a root and marks the root modified.
 * @param {object} tenant generated tenant (mutated in place)
 * @param {{team_id: string, channel_id: string, root_id: string, text_seed?: number, image?: boolean}} target
 * @returns {object} the new reply
 */
export function add_reply(tenant, { team_id, channel_id, root_id, text_seed, image = false }) {
  const { channel, root } = find_root(tenant, team_id, channel_id, root_id);
  tenant.seq += 1;
  const reply = {
    id: String(1_800_000_000_000 + tenant.seq),
    created_ms: NOW_MS,
    from: root.from,
    text_seed: text_seed ?? derive_seed('reply', tenant.seq),
    hosted: image
      ? [build_hosted(tenant.seq, 1, create_rng(derive_seed('image', tenant.seq)))]
      : [],
  };
  root.replies.push(reply);
  stamp_change(channel, root);
  return reply;
}

/**
 * Edits a root's body. The body seed changes, so the stored blob for the root is rewritten.
 * @param {object} tenant generated tenant (mutated in place)
 * @param {{team_id: string, channel_id: string, root_id: string}} target
 */
export function edit_root(tenant, { team_id, channel_id, root_id }) {
  const { channel, root } = find_root(tenant, team_id, channel_id, root_id);
  root.text_seed = derive_seed('root-edit', channel.seq + 1);
  stamp_change(channel, root);
}

/**
 * Soft-deletes a root. Its hosted content leaves the expected download set.
 * @param {object} tenant generated tenant (mutated in place)
 * @param {{team_id: string, channel_id: string, root_id: string}} target
 */
export function delete_root(tenant, { team_id, channel_id, root_id }) {
  const { channel, root } = find_root(tenant, team_id, channel_id, root_id);
  channel.seq += 1;
  root.deleted_version = channel.seq;
  root.deleted_ms = NOW_MS;
  root.version = channel.seq;
  root.replies = [];
  root.hosted = [];
}

/**
 * Applies the mutation set the sync scenario runs before its third pass: new replies with one
 * hosted image each, one edit, and one deletion, each on a different live root.
 * @param {object} tenant generated tenant (mutated in place)
 * @param {{replies?: number}} [options]
 * @returns {{replies: number, new_images: number, edits: number, deletions: number}}
 */
export function mutate_for_sync(tenant, { replies = 3 } = {}) {
  const rng = create_rng(derive_seed('mutation', tenant.shape.seed));
  const picked = pick_distinct(rng, live_roots(tenant), replies + 2);
  for (const target of picked.slice(0, replies)) add_reply(tenant, { ...target, image: true });
  edit_root(tenant, picked[replies]);
  delete_root(tenant, picked[replies + 1]);
  return { replies, new_images: replies, edits: 1, deletions: 1 };
}

/** Advances the channel's change sequence and stamps the root with it, as a change to it. */
function stamp_change(channel, root) {
  channel.seq += 1;
  root.version = channel.seq;
  root.modified_ms = NOW_MS;
}

/** Every root that is not deleted, as mutation targets, in model order. */
function live_roots(tenant) {
  const targets = [];
  for (const team of tenant.teams) {
    for (const channel of team.channels) {
      for (const root of channel.roots) {
        if (root.deleted_ms === undefined) {
          targets.push({ team_id: team.id, channel_id: channel.id, root_id: root.id });
        }
      }
    }
  }
  return targets;
}

/** Picks `count` distinct items with a partial Fisher-Yates shuffle. */
function pick_distinct(rng, items, count) {
  if (count > items.length)
    throw new Error(`mutate-tenant: need ${count} roots, have ${items.length}`);
  const pool = [...items];
  for (let i = 0; i < count; i++) {
    const j = rng.int(i, pool.length - 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** @returns {{channel: object, root: object}} the target; throws when it does not exist */
function find_root(tenant, team_id, channel_id, root_id) {
  const channel = tenant.team_by_id.get(team_id)?.channel_by_id.get(channel_id);
  const root = channel?.root_by_id.get(root_id);
  if (!channel || !root) {
    throw new Error(`mutate-tenant: no root ${root_id} in ${team_id}/${channel_id}`);
  }
  return { channel, root };
}
