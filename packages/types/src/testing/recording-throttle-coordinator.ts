import type { GraphServicePool } from '@/domain/graph/cost';
import type { ThrottleCoordinator } from '@/ports/shared/throttle-coordinator.port';

/** A {@link ThrottleCoordinator} that also records every call, for asserting throttling behaviour. */
export interface RecordingThrottleCoordinator extends ThrottleCoordinator {
  /** The pool of every `wait` call, in order. */
  readonly waits: GraphServicePool[];
  /** The pool and `retry_after_ms` of every `raise` call, in order. */
  readonly raises: Array<[GraphServicePool, number]>;
}

/** Builds a coordinator that never delays a caller and records each call in order. */
export function recording_throttle_coordinator(): RecordingThrottleCoordinator {
  const waits: GraphServicePool[] = [];
  const raises: Array<[GraphServicePool, number]> = [];
  return {
    waits,
    raises,
    wait: async (pool) => {
      waits.push(pool);
    },
    raise: (pool, retry_after_ms) => {
      raises.push([pool, retry_after_ms]);
    },
  };
}
