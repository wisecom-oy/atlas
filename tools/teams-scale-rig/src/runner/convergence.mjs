/**
 * Reads the latest snapshot of each team back through the Teams repositories and reduces it to a
 * canonical form. Storage keys, snapshot ids, and checksums depend on the DEK and the run, so the
 * canonical form leaves them out. The storage key of each hosted blob is returned beside it, keyed
 * by hosted id, so a check can tell which stored blobs a run actually downloaded.
 */
import {
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import { FsObjectStorage } from './fs-object-storage.mjs';

/**
 * @param {{container: object, tenant_factory: object, tenant_id: string, team_ids: string[]}} read
 * @returns {Promise<{teams: Record<string, object|null>, hosted_keys: Map<string, string>}>}
 *   the canonical snapshot per team (null when the team has no readable index), and the storage
 *   key of every hosted blob the snapshots reference, keyed by hosted id
 */
export async function read_converged_snapshot({ container, tenant_factory, tenant_id, team_ids }) {
  const ctx = await tenant_factory.create_readonly(tenant_id);
  const indexes = container.get(TEAMS_INDEX_REPOSITORY_TOKEN);
  const shards = container.get(TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN);
  const teams = {};
  const hosted_keys = new Map();
  try {
    for (const team_id of team_ids) {
      const { index } = await indexes.find_latest_readable(ctx, team_id);
      if (!index) {
        teams[team_id] = null;
        continue;
      }
      const channels = [];
      for (const entry of [...index.channels].sort((a, b) => cmp(a.channel_id, b.channel_id))) {
        const shard = await shards.load(ctx, entry.shard_key);
        channels.push(canonical_channel(entry, shard));
        collect_hosted_keys(shard, hosted_keys);
      }
      teams[team_id] = { channels };
    }
  } finally {
    ctx.destroy();
  }
  return { teams, hosted_keys };
}

/** Index entry plus the shard's threads, reduced to content-bearing fields. */
function canonical_channel(entry, shard) {
  return {
    channel_id: entry.channel_id,
    deleted_at: entry.deleted_at ?? null,
    thread_count: entry.thread_count,
    message_count: entry.message_count,
    threads: Object.keys(shard.threads)
      .sort(cmp)
      .map((root_id) => {
        const thread = shard.threads[root_id];
        return {
          root_id,
          deleted_at: thread.deleted_at ?? null,
          root: message_view(thread.root),
          replies: Object.keys(thread.replies)
            .sort(cmp)
            .map((id) => ({ id, ...message_view(thread.replies[id]) })),
        };
      }),
  };
}

function message_view(ref) {
  return {
    last_modified_at: ref.last_modified_at,
    deleted_at: ref.deleted_at ?? null,
    hosted: Object.keys(ref.hosted).sort(cmp),
    hosted_missing: [...(ref.hosted_missing ?? [])].sort(cmp),
  };
}

/** Adds the storage key of every hosted blob that a shard's messages reference. */
function collect_hosted_keys(shard, into) {
  for (const thread of Object.values(shard.threads)) {
    for (const ref of [thread.root, ...Object.values(thread.replies)]) {
      for (const [hosted_id, hosted] of Object.entries(ref.hosted)) {
        into.set(hosted_id, hosted.storage_key);
      }
    }
  }
}

/** Storage keys of every hosted-content blob the store holds for the tenant. */
export async function list_hosted_blob_keys(store_tenant_dir) {
  const keys = await new FsObjectStorage(store_tenant_dir).list('');
  return keys.filter((k) => /(^|\/)hosted\//.test(k));
}

/** Locale-independent comparison for stable sorts. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two sets of canonical team snapshots channel by channel. A team without a readable
 * snapshot on either side is a problem: two empty results must not count as converged.
 * @returns {string[]} one line per problem team; empty when they converge
 */
export function diff_snapshots(expected, actual) {
  const problems = [];
  for (const team_id of Object.keys(expected)) {
    const want = expected[team_id];
    const got = actual[team_id];
    if (want == null || got == null) {
      problems.push(
        `team ${team_id}: no readable snapshot (expected ${want ? 'present' : 'missing'}, actual ${got ? 'present' : 'missing'})`,
      );
      continue;
    }
    if (JSON.stringify(want) === JSON.stringify(got)) continue;
    const want_channels = new Map(want.channels.map((c) => [c.channel_id, c]));
    const got_channels = new Map((got.channels ?? []).map((c) => [c.channel_id, c]));
    const ids = [...new Set([...want_channels.keys(), ...got_channels.keys()])];
    const bad = ids.filter(
      (id) => JSON.stringify(want_channels.get(id)) !== JSON.stringify(got_channels.get(id)),
    );
    const first = bad[0];
    const where =
      first === undefined
        ? '(team level)'
        : `first ${first}: ${first_thread_difference(want_channels.get(first), got_channels.get(first))}`;
    problems.push(`team ${team_id}: ${bad.length} channel(s) differ, ${where}`);
  }
  return problems;
}

/** Names the first thread that differs between two canonical channels, truncated for a report. */
function first_thread_difference(want, got) {
  const want_threads = new Map((want?.threads ?? []).map((t) => [t.root_id, t]));
  const got_threads = new Map((got?.threads ?? []).map((t) => [t.root_id, t]));
  const root_ids = [...new Set([...want_threads.keys(), ...got_threads.keys()])].sort(cmp);
  const root_id = root_ids.find(
    (id) => JSON.stringify(want_threads.get(id)) !== JSON.stringify(got_threads.get(id)),
  );
  if (root_id === undefined) return 'channel-level fields differ';
  const show = (t) => JSON.stringify(t ?? null).slice(0, 400);
  return `thread ${root_id} expected ${show(want_threads.get(root_id))} actual ${show(got_threads.get(root_id))}`;
}

/**
 * Checks the blobs a resumed run touched against the store as it stood at the kill.
 * - reused: blobs downloaded on resume that the store already held at the kill (must be empty)
 * - unaccounted: blobs the converged snapshot references that neither the kill stored nor the
 *   resume downloaded (must be empty)
 * - unmapped: resumed downloads whose hosted id no converged snapshot references (must be empty)
 * @param {{keys_at_kill: Set<string>, served_ids: Set<string>, hosted_keys: Map<string, string>}} input
 * @returns {{reused: string[], unaccounted: string[], unmapped: string[]}}
 */
export function resume_blob_problems({ keys_at_kill, served_ids, hosted_keys }) {
  const unmapped = [];
  const downloaded = new Set();
  for (const id of served_ids) {
    const key = hosted_keys.get(id);
    if (key === undefined) unmapped.push(id);
    else downloaded.add(key);
  }
  const reused = [...downloaded].filter((key) => keys_at_kill.has(key));
  const referenced = new Set(hosted_keys.values());
  const unaccounted = [...referenced].filter(
    (key) => !keys_at_kill.has(key) && !downloaded.has(key),
  );
  return { reused, unaccounted, unmapped };
}
