import type { GraphServicePool, ThrottleCoordinator } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Wraps a host-supplied {@link ThrottleCoordinator} so its failures never stop a Graph request.
 *
 * A host coordinator is usually backed by shared state in another service. When that state is
 * unreachable, a `wait` that rejects would abort every request before it is sent, and a `raise`
 * that throws would replace the Graph error and end the retry loop, so one outage would halt every
 * backup on the coordinator. Coordination is an optimisation layered on top of each request's own
 * backoff, so it fails open: a failed `wait` lets the request through, and a failed `raise` is
 * logged while the retry loop carries on with its own Retry-After delay.
 */
export class FailOpenThrottleCoordinator implements ThrottleCoordinator {
  constructor(private readonly _inner: ThrottleCoordinator) {}

  /** Waits on the host coordinator, proceeding without it if it fails. */
  async wait(pool: GraphServicePool): Promise<void> {
    try {
      await this._inner.wait(pool);
    } catch (err) {
      logger.warn(
        `Throttle coordinator wait failed for ${pool}; sending without it: ${describe(err)}`,
      );
    }
  }

  /** Reports a 429 to the host coordinator, logging rather than throwing if it fails. */
  raise(pool: GraphServicePool, retry_after_ms: number): void {
    try {
      const result: unknown = this._inner.raise(pool, retry_after_ms);
      // `raise` is typed void, but a host backed by a network store may still return a promise.
      if (is_thenable(result)) {
        result.then(undefined, (err: unknown) => log_raise_failure(pool, err));
      }
    } catch (err) {
      log_raise_failure(pool, err);
    }
  }
}

function log_raise_failure(pool: GraphServicePool, err: unknown): void {
  logger.warn(
    `Throttle coordinator raise failed for ${pool}; backing off locally: ${describe(err)}`,
  );
}

function is_thenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
