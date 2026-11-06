import { injectable } from 'inversify';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';
import type { TeamsRequestClass } from '@/services/backup/teams-request-stats';

/** Requests per second each Teams lane is paced at. */
export interface TeamsPacingRates {
  /** Messages class, per tenant. */
  readonly tenant_messages_rps: number;
  /** Default class, per tenant. */
  readonly tenant_default_rps: number;
  /** Default class, per team. */
  readonly team_rps: number;
  /** Messages class, per channel. */
  readonly channel_rps: number;
}

const HEADROOM = 0.8;

/** 80% of the Graph Teams limits, leaving the rest for other clients of the same tenant. */
export const DEFAULT_TEAMS_PACING_RATES: TeamsPacingRates = Object.freeze({
  tenant_messages_rps: GRAPH_SERVICE_LIMITS.teams.messages_requests_per_second * HEADROOM,
  tenant_default_rps: GRAPH_SERVICE_LIMITS.teams.team_requests_per_second * HEADROOM,
  team_rps: GRAPH_SERVICE_LIMITS.teams.team_requests_per_second_per_team * HEADROOM,
  channel_rps: GRAPH_SERVICE_LIMITS.teams.messages_requests_per_second_per_channel * HEADROOM,
});

/**
 * Pacing rates with the tenant-wide lanes scaled to `share` of the default. Several processes that
 * back up one tenant split the tenant budget this way; team and channel lanes stay whole, because
 * one team runs in one process at a time.
 */
export function tenant_share_rates(share: number): Partial<TeamsPacingRates> {
  return {
    tenant_messages_rps: DEFAULT_TEAMS_PACING_RATES.tenant_messages_rps * share,
    tenant_default_rps: DEFAULT_TEAMS_PACING_RATES.tenant_default_rps * share,
  };
}

/** The Graph target one request counts against. Team and channel are absent when not applicable. */
export interface PacedRequest {
  readonly request_class: TeamsRequestClass;
  readonly tenant_id: string;
  readonly team_id?: string | undefined;
  readonly channel_id?: string | undefined;
}

interface Lane {
  readonly key: string;
  readonly interval_ms: number;
}

/** Above this many lanes, idle lanes are dropped; an idle lane behaves like a fresh one. */
const MAX_LANES = 4096;

/**
 * Spaces Teams Graph requests so a run stays under the per-tenant, per-team and per-channel limits
 * before Graph has to throttle it. Each lane keeps the earliest time its next request may start. A
 * request waits until every lane it counts against is free at the same moment, then takes all of
 * them at once. Nothing is reserved while it waits, so a request parked on a busy channel never
 * holds a tenant slot it cannot use, and requests released together cannot burst past any lane.
 *
 * Partial rates let tests and the scale rig override the defaults. The argument has a default, so
 * the container can construct the pacer without injected parameters.
 */
@injectable()
export class TeamsRequestPacer {
  private readonly _rates: TeamsPacingRates;
  private readonly _next_start = new Map<string, number>();

  constructor(rates: Partial<TeamsPacingRates> = {}) {
    this._rates = { ...DEFAULT_TEAMS_PACING_RATES, ...rates };
  }

  /** Waits until every lane `request` counts against is free, then takes them, or `signal` fires. */
  async acquire(request: PacedRequest, signal?: AbortSignal): Promise<void> {
    const lanes = this.lanes_for(request);
    for (;;) {
      const now = Date.now();
      const free_at = Math.max(now, ...lanes.map((l) => this._next_start.get(l.key) ?? now));
      if (free_at <= now) {
        for (const l of lanes) this._next_start.set(l.key, now + l.interval_ms);
        this.prune_idle_lanes(now);
        return;
      }
      // ponytail: waiters on one lane wake together and race; no FIFO. Per-lane queues if starvation shows.
      await sleep_until(free_at, signal);
    }
  }

  /** The lanes a request counts against. */
  private lanes_for(request: PacedRequest): Lane[] {
    const { tenant_id, team_id, channel_id } = request;
    if (request.request_class === 'messages') {
      const tenant = lane(['messages', tenant_id], this._rates.tenant_messages_rps);
      return team_id !== undefined && channel_id !== undefined
        ? [lane(['channel', tenant_id, team_id, channel_id], this._rates.channel_rps), tenant]
        : [tenant];
    }
    const tenant = lane(['default', tenant_id], this._rates.tenant_default_rps);
    return team_id !== undefined
      ? [lane(['team', tenant_id, team_id], this._rates.team_rps), tenant]
      : [tenant];
  }

  /** Drops lanes whose next slot is already past, once the map has grown past its cap. */
  private prune_idle_lanes(now: number): void {
    if (this._next_start.size <= MAX_LANES) return;
    for (const [key, next] of this._next_start) {
      if (next <= now) this._next_start.delete(key);
    }
  }
}

/** Builds a lane keyed by its parts. JSON keeps ids containing separators from colliding. */
function lane(parts: readonly string[], rps: number): Lane {
  return { key: JSON.stringify(parts), interval_ms: 1000 / rps };
}

/** Resolves at `slot` (epoch ms), or rejects as soon as `signal` fires. */
function sleep_until(slot: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled(signal));
  const delay = slot - Date.now();
  if (delay <= 0) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const on_abort = (): void => {
    clearTimeout(timer);
    reject(cancelled(signal));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', on_abort);
    resolve();
  }, delay);
  signal?.addEventListener('abort', on_abort, { once: true });
  return promise;
}

/** The error a cancelled run rejects with: the signal's reason when it is an Error. */
function cancelled(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error('The run was cancelled');
}
