/**
 * Per-class request counters kept by the fake server.
 *
 * Counters are cumulative; scenarios take a snapshot before and after a run and report the
 * difference, so the same server can serve several runs.
 */

/** Creates an empty counter set. */
export function create_request_stats() {
  const stats = {
    classes: { messages: empty_class(), default: empty_class() },
    throttled_by_team: new Map(),
    routes: new Map(),
    channels_touched: new Set(),
    hosted_downloads: 0,
    hosted_bytes: 0,
    hosted_ids: new Set(),
  };
  return {
    /** Records one attempt, admitted or throttled. */
    record(cls, team, admitted, route = 'unnamed') {
      const c = stats.classes[cls];
      c.attempts += 1;
      stats.routes.set(route, (stats.routes.get(route) ?? 0) + 1);
      if (admitted) c.admitted += 1;
      else {
        c.throttled += 1;
        if (team) stats.throttled_by_team.set(team, (stats.throttled_by_team.get(team) ?? 0) + 1);
      }
    },
    /** Records a channel whose messages were served. */
    touch_channel(channel) {
      stats.channels_touched.add(channel);
    },
    /** Records one hosted image download, by its hosted id. */
    record_hosted(bytes, id) {
      stats.hosted_downloads += 1;
      stats.hosted_bytes += bytes;
      stats.hosted_ids.add(id);
    },
    /** Returns a deep copy of the current counters. */
    snapshot() {
      return {
        classes: {
          messages: { ...stats.classes.messages },
          default: { ...stats.classes.default },
        },
        throttled_by_team: new Map(stats.throttled_by_team),
        routes: new Map(stats.routes),
        channels_touched: stats.channels_touched.size,
        hosted_downloads: stats.hosted_downloads,
        hosted_bytes: stats.hosted_bytes,
        hosted_ids: new Set(stats.hosted_ids),
      };
    },
    /** Clears all counters. */
    reset() {
      stats.classes.messages = empty_class();
      stats.classes.default = empty_class();
      stats.throttled_by_team.clear();
      stats.routes.clear();
      stats.channels_touched.clear();
      stats.hosted_downloads = 0;
      stats.hosted_bytes = 0;
      stats.hosted_ids.clear();
    },
  };
}

/** @returns {{attempts: number, admitted: number, throttled: number}} */
function empty_class() {
  return { attempts: 0, admitted: 0, throttled: 0 };
}
