/**
 * Issue #641: a Retry-After above 5 minutes failed the call after one attempt, although the parser
 * and the coordinator accept up to an hour, and every caller parked behind a cooldown resumed in
 * the same instant, which drew the next 429.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import {
  run_with_abort_signal,
  run_with_throttle_coordinator,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { with_graph_retry } from '@/graph-request-error-handler';

const POOL = 'sharepoint_onedrive';
const SIX_MINUTES_MS = 360_000;
/** The release jitter bound for a 6-minute cooldown: a tenth of it, capped at 5 seconds. */
const JITTER_BOUND_MS = 5_000;

function throttled(retry_after_seconds: string): Record<string, unknown> {
  return {
    statusCode: 429,
    message: 'Too Many Requests',
    headers: new Headers({ 'retry-after': retry_after_seconds }),
  };
}

/** A Graph call that is throttled once with `retry_after_seconds`, then succeeds. */
function throttled_once(retry_after_seconds: string) {
  return vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(throttled(retry_after_seconds))
    .mockResolvedValue('ok');
}

describe('with_graph_retry and a Retry-After above 5 minutes', () => {
  let coordinator: InProcessThrottleCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new InProcessThrottleCoordinator();
  });

  afterEach(() => {
    coordinator.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('waits out a 6 minute Retry-After without a coordinator, then succeeds', async () => {
    const fn = throttled_once('360');

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(SIX_MINUTES_MS - 1);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(JITTER_BOUND_MS + 1);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('hands a 6 minute Retry-After to the coordinator, which holds the pool for it', async () => {
    const fn = throttled_once('360');

    const promise = run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(SIX_MINUTES_MS - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(coordinator.is_cooling(POOL)).toBe(true);

    await vi.advanceTimersByTimeAsync(JITTER_BOUND_MS + 1);
    expect(coordinator.is_cooling(POOL)).toBe(false);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('waits out a Retry-After of exactly the 1 hour cap', async () => {
    const fn = throttled_once('3600');

    const promise = run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(3_600_000 - 1);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(JITTER_BOUND_MS + 1);
    await expect(promise).resolves.toBe('ok');
  });

  it.each([
    ['without a coordinator', false],
    ['with a coordinator', true],
  ])('stops a 6 minute wait as soon as the run is cancelled, %s', async (_label, coordinated) => {
    const fn = throttled_once('360');
    const controller = new AbortController();
    const call = (): Promise<string> => with_graph_retry(fn);

    const promise = run_with_abort_signal(controller.signal, () =>
      coordinated ? run_with_throttle_coordinator(coordinator, POOL, call) : call(),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    controller.abort(new Error('run cancelled'));

    await expect(promise).rejects.toThrow('run cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
    // Only the fence's own cooldown timer may remain; clear() is the shutdown path for it.
    coordinator.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases calls parked behind a 6 minute cooldown at spread times, none before it ends', async () => {
    const randoms = [0.05, 0.35, 0.65, 0.95, 0.2];
    vi.spyOn(Math, 'random').mockImplementation(() => randoms.shift() ?? 0.5);
    const started = Date.now();
    const sent_at: number[] = [];
    const record = (): Promise<string> => {
      sent_at.push(Date.now() - started);
      return Promise.resolve('ok');
    };

    coordinator.raise(POOL, SIX_MINUTES_MS);
    const parked = Array.from({ length: 4 }, () =>
      run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(record)),
    );
    await vi.advanceTimersByTimeAsync(SIX_MINUTES_MS + JITTER_BOUND_MS);
    await Promise.all(parked);

    expect(sent_at).toHaveLength(4);
    expect(Math.min(...sent_at)).toBeGreaterThanOrEqual(SIX_MINUTES_MS);
    expect(Math.max(...sent_at)).toBeLessThan(SIX_MINUTES_MS + JITTER_BOUND_MS);
    expect(new Set(sent_at).size).toBe(4);
    expect(Math.max(...sent_at) - Math.min(...sent_at)).toBeGreaterThanOrEqual(4_000);
  });
});
