/**
 * Issue #196: the throttle fence has to engage on the response that carried the
 * 429 and has to gate every subsequent HTTP attempt, including attempts made by
 * retry loops that were already running when the fence went up.
 *
 * The regression these guard against is invisible from the outside: a call still
 * fails with 429 either way, it just spends the whole cooldown hammering Graph
 * with the requests the cooldown exists to prevent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { with_graph_retry } from '@/graph-request-error-handler';

/** Retry budget in `with_graph_retry`: 12 retries after the first attempt. */
const MAX_ATTEMPTS = 13;

function throttled(retry_after_seconds: string): Record<string, unknown> {
  return {
    statusCode: 429,
    message: 'Too Many Requests',
    headers: { 'retry-after': retry_after_seconds },
  };
}

/** The pool these calls are charged to; the coordinator keeps one cooldown per pool. */
const POOL = 'outlook';

describe('with_graph_retry and the throttle coordinator', () => {
  let coordinator: InProcessThrottleCoordinator;
  const run_fenced = <T>(fn: () => Promise<T>): Promise<T> =>
    run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(fn));

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new InProcessThrottleCoordinator();
  });

  afterEach(() => {
    coordinator.clear();
    vi.useRealTimers();
  });

  it('starts the cooldown on the first 429, not after the retry budget', async () => {
    let attempts = 0;
    const fn = (): Promise<never> => {
      attempts++;
      return Promise.reject(throttled('5'));
    };

    const promise = run_fenced(fn).catch((e: unknown) => e);

    // Let the first attempt run and reject, without advancing into the backoff.
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts).toBe(1);
    expect(coordinator.is_cooling(POOL)).toBe(true);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await promise;
  });

  it('parks a retry loop that started before the cooldown began', async () => {
    // The fence is raised by a third party mid-loop, so this asserts the per
    // attempt wait() on its own rather than the raise path. A loop failing on
    // 500s backs off ~1-2s, so without that wait its next attempt lands well
    // inside the cooldown.
    const fired_while_raised: number[] = [];
    let attempts = 0;
    const fn = (): Promise<string> => {
      attempts++;
      if (coordinator.is_cooling(POOL)) fired_while_raised.push(attempts);
      if (attempts < 3) return Promise.reject({ statusCode: 500, message: 'Server error' });
      return Promise.resolve('ok');
    };

    const promise = run_fenced(fn);

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    // Another owner hits a 429 and the cooldown starts while this loop is between
    // attempts.
    coordinator.raise(POOL, 60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    await expect(promise).resolves.toBe('ok');
    expect(fired_while_raised).toEqual([]);
  });

  it('starts no cooldown and leaves retries untouched when no 429 arrives', async () => {
    let attempts = 0;
    const fn = (): Promise<string> => {
      attempts++;
      if (attempts === 1) return Promise.reject({ statusCode: 503, message: 'Unavailable' });
      return Promise.resolve('recovered');
    };

    const promise = run_fenced(fn);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(promise).resolves.toBe('recovered');
    expect(attempts).toBe(2);
    expect(coordinator.is_cooling(POOL)).toBe(false);
  });

  it('bounds a logical call at the retry budget, with no second retry layer under it', async () => {
    let attempts = 0;
    const fn = (): Promise<never> => {
      attempts++;
      return Promise.reject(throttled('1'));
    };

    const promise = run_fenced(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await promise;

    expect(attempts).toBe(MAX_ATTEMPTS);
  });

  it('is inert with no coordinator in context', async () => {
    let attempts = 0;
    const fn = (): Promise<never> => {
      attempts++;
      return Promise.reject(throttled('1'));
    };

    const promise = with_graph_retry(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(await promise).toMatchObject({ cause: { statusCode: 429 } });
    expect(attempts).toBe(MAX_ATTEMPTS);
  });

  it('applies a default cooldown when a 429 carries no usable Retry-After', async () => {
    const fn = (): Promise<never> => Promise.reject({ statusCode: 429, message: 'Throttled' });

    const promise = run_fenced(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);

    expect(coordinator.is_cooling(POOL)).toBe(true);

    // 30s default: still raised just before, lowered just after.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(coordinator.is_cooling(POOL)).toBe(true);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await promise;
  });
});
