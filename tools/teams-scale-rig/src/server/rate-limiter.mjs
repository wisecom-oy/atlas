/**
 * Token buckets that mirror the Teams service limits, scaled by a time factor k.
 *
 * A request is admitted only when every bucket that applies to it has a token; tokens are spent
 * only on admission, so a 429 never drains capacity. Capacity equals one second of rate.
 */
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';

/**
 * Server-side limits for the given time scale. `time_scale` multiplies every rate, so a run
 * finishes roughly k times faster while the pacer and the server stay proportionally matched.
 * @param {number} time_scale
 */
export function teams_limits(time_scale = 1) {
  const limits = GRAPH_SERVICE_LIMITS.teams;
  return {
    tenant_messages_rps: limits.messages_requests_per_second * time_scale,
    channel_messages_rps: limits.messages_requests_per_second_per_channel * time_scale,
    tenant_default_rps: limits.team_requests_per_second * time_scale,
    team_default_rps: limits.team_requests_per_second_per_team * time_scale,
  };
}

/**
 * Creates the limiter.
 * @param {ReturnType<typeof teams_limits>} limits
 */
export function create_rate_limiter(limits) {
  const buckets = new Map();
  const team_overrides = new Map();

  function bucket_for(key, rate, now_ms) {
    let b = buckets.get(key);
    if (!b) {
      b = { rate, tokens: rate, last_ms: now_ms };
      buckets.set(key, b);
    }
    return b;
  }

  /** Refills a bucket to `now_ms` and returns the seconds until it holds one token. */
  function wait_seconds(b, now_ms) {
    b.tokens = Math.min(b.rate, b.tokens + (Math.max(0, now_ms - b.last_ms) / 1000) * b.rate);
    b.last_ms = now_ms;
    return b.tokens >= 1 ? 0 : (1 - b.tokens) / b.rate;
  }

  /** Buckets a request must pass, as [key, rate] pairs. */
  function buckets_for(request) {
    if (request.cls === 'messages') {
      const out = [['tenant:messages', limits.tenant_messages_rps]];
      if (request.channel) out.push([`channel:${request.channel}`, limits.channel_messages_rps]);
      return out;
    }
    const out = [['tenant:default', limits.tenant_default_rps]];
    if (request.team) {
      const rate = team_overrides.get(request.team) ?? limits.team_default_rps;
      out.push([`team:${request.team}`, rate]);
    }
    return out;
  }

  return {
    /**
     * Admits or rejects one request.
     * @param {{cls: 'messages'|'default', team?: string, channel?: string, now_ms?: number}} request
     * @returns {{ok: true} | {ok: false, retry_after_s: number}}
     */
    admit(request) {
      const now_ms = request.now_ms ?? Date.now();
      const entries = buckets_for(request).map(([key, rate]) => bucket_for(key, rate, now_ms));
      const waits = entries.map((b) => wait_seconds(b, now_ms));
      const worst = Math.max(...waits);
      if (worst > 0) return { ok: false, retry_after_s: Math.max(1, Math.ceil(worst)) };
      for (const b of entries) b.tokens -= 1;
      return { ok: true };
    },
    /**
     * Overrides the default-class rate for one team. Used by the throttle isolation scenario to
     * make a single team hit 429s while others run at full speed.
     * @param {string} team_id
     * @param {number} rps
     */
    set_team_rate(team_id, rps) {
      team_overrides.set(team_id, rps);
      buckets.delete(`team:${team_id}`);
    },
  };
}
