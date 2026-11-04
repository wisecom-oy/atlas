/**
 * Compares two canonical team snapshots on live content only. A live thread must match exactly,
 * root and every reply. A root deleted on either side must be deleted on both, and the deleted
 * root's `deleted_at` and reply set are ignored: an observed removal is dated by the backup time
 * and keeps the replies already stored, while a fresh full read sees Graph's own deletion time
 * and whatever replies Graph still lists. Channel counts are ignored for the same reason, since
 * they include deleted roots.
 */

/**
 * @param {Record<string, object|null>} expected canonical snapshot per team (from the control)
 * @param {Record<string, object|null>} actual canonical snapshot per team (from the run under test)
 * @returns {string[]} one line per problem team; empty when live content converges
 */
export function diff_live_content(expected, actual) {
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
    const bad = channel_problems(want.channels, got.channels ?? []);
    if (bad.length > 0) {
      problems.push(`team ${team_id}: ${bad.length} channel(s) differ, first ${bad[0]}`);
    }
  }
  return problems;
}

/** One line per channel whose live content differs; empty when every channel converges. */
function channel_problems(want_channels, got_channels) {
  const want = new Map(want_channels.map((c) => [c.channel_id, c]));
  const got = new Map(got_channels.map((c) => [c.channel_id, c]));
  const ids = [...new Set([...want.keys(), ...got.keys()])].sort(cmp);
  const problems = [];
  for (const id of ids) {
    const difference = channel_difference(want.get(id), got.get(id));
    if (difference !== null) problems.push(`${id}: ${difference}`);
  }
  return problems;
}

/** Names the first difference between two canonical channels, or null when they converge. */
function channel_difference(want, got) {
  if (!want || !got) {
    return `channel present only on ${want ? 'expected' : 'actual'} side`;
  }
  if ((want.deleted_at != null) !== (got.deleted_at != null)) {
    return 'channel deleted on one side only';
  }
  const want_threads = new Map((want.threads ?? []).map((t) => [t.root_id, t]));
  const got_threads = new Map((got.threads ?? []).map((t) => [t.root_id, t]));
  const root_ids = [...new Set([...want_threads.keys(), ...got_threads.keys()])].sort(cmp);
  for (const root_id of root_ids) {
    const difference = thread_difference(
      root_id,
      want_threads.get(root_id),
      got_threads.get(root_id),
    );
    if (difference !== null) return difference;
  }
  return null;
}

/** Names the difference between one thread on both sides, or null when they converge. */
function thread_difference(root_id, want, got) {
  if (!want || !got) {
    return `thread ${root_id} present only on ${want ? 'expected' : 'actual'} side`;
  }
  const want_deleted = is_deleted(want);
  const got_deleted = is_deleted(got);
  if (want_deleted !== got_deleted) {
    return `thread ${root_id} deleted on ${want_deleted ? 'expected' : 'actual'} side only`;
  }
  if (want_deleted) return null;
  if (JSON.stringify(live_view(want)) === JSON.stringify(live_view(got))) return null;
  return `thread ${root_id} expected ${show(live_view(want))} actual ${show(live_view(got))}`;
}

/** A thread is deleted when its thread or its root carries a deletion time. */
function is_deleted(thread) {
  return thread.deleted_at != null || thread.root.deleted_at != null;
}

/** The fields compared for a live thread: the root and every reply, nothing else. */
function live_view(thread) {
  return { root_id: thread.root_id, root: thread.root, replies: thread.replies };
}

function show(value) {
  return JSON.stringify(value).slice(0, 400);
}

/** Locale-independent comparison for stable sorts. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
