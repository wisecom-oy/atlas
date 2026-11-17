import { AsyncLocalStorage } from 'node:async_hooks';
import type { TeamsRequestClassReport, TeamsRequestReport } from '@wisecom/atlas-types';

/** The two Graph limit classes a Teams request counts against. See `TeamsRequestReport`. */
export type TeamsRequestClass = 'messages' | 'default';

interface ClassCounts {
  requests: number;
  throttled: number;
}

/** Counts one team run's Graph requests per limit class, and the 429s returned for them. */
export class TeamsRequestStats {
  private readonly _counts: Record<TeamsRequestClass, ClassCounts> = {
    messages: { requests: 0, throttled: 0 },
    default: { requests: 0, throttled: 0 },
  };

  /** Counts one request attempt against `request_class`. */
  record_attempt(request_class: TeamsRequestClass): void {
    this._counts[request_class].requests += 1;
  }

  /** Counts one 429 response against `request_class`. */
  record_throttled(request_class: TeamsRequestClass): void {
    this._counts[request_class].throttled += 1;
  }

  /** The report for the run so far, with achieved rates over `elapsed_ms`. */
  snapshot(elapsed_ms: number): TeamsRequestReport {
    return {
      messages: class_report(this._counts.messages, elapsed_ms),
      default: class_report(this._counts.default, elapsed_ms),
    };
  }
}

/** Achieved requests per second, two decimals; zero when no time has passed. */
function class_report(counts: ClassCounts, elapsed_ms: number): TeamsRequestClassReport {
  const seconds = elapsed_ms / 1000;
  const achieved = seconds > 0 ? counts.requests / seconds : 0;
  return {
    requests: counts.requests,
    throttled: counts.throttled,
    achieved_rps: Math.round(achieved * 100) / 100,
  };
}

const _stats = new AsyncLocalStorage<TeamsRequestStats>();

/** Publishes the stats collector for the Teams requests issued inside `fn`. */
export function run_with_teams_request_stats<T>(stats: TeamsRequestStats, fn: () => T): T {
  return _stats.run(stats, fn);
}

/** The stats collector the current async context counts into, if any. */
export function get_active_teams_request_stats(): TeamsRequestStats | undefined {
  return _stats.getStore();
}
