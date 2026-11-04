/**
 * Retry-After and the per-call retry budget in `with_graph_retry`.
 *
 * The Graph SDK puts the response's fetch `Headers` object on the error, not a plain record. A
 * plain property read never found Retry-After, so every 429 fell back to the 30 s default cooldown
 * and three throttled responses took about 94 s. These tests use a real `Headers` object so they
 * exercise the shape the SDK actually delivers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { ThrottledError } from '@wisecom/atlas-types';
import { with_graph_retry } from '@/graph-request-error-handler';

const POOL = 'outlook';
const MINUTE_MS = 60_000;

function throttled(retry_after_seconds: string): Record<string, unknown> {
  return {
    statusCode: 429,
    message: 'Too Many Requests',
    headers: new Headers({ 'retry-after': retry_after_seconds }),
  };
}

describe('with_graph_retry Retry-After from the SDK Headers object', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits exactly the Retry-After value, without jitter, before the next attempt', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(throttled('1'))
      .mockResolvedValue('ok');

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('fails with ThrottledError without retrying when Retry-After exceeds the 5 minute cap', async () => {
    const err = throttled('600');
    const fn = vi.fn().mockRejectedValue(err);

    const result = await with_graph_retry(fn).catch((e: unknown) => e);

    expect(result).toBeInstanceOf(ThrottledError);
    expect(result).toMatchObject({ code: 'ATLAS_THROTTLED', retry_after_ms: 600_000, cause: err });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the next wait would pass the 24 minute budget', async () => {
    const fn = vi.fn().mockRejectedValue(throttled('300'));

    const promise = with_graph_retry(fn).catch((e: unknown) => e);
    // Attempts land at 0, 5, 10, 15 and 20 minutes. A sixth would start at 25 minutes, past the 24 minute budget.
    await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);

    expect(await promise).toBeInstanceOf(ThrottledError);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});

describe('with_graph_retry cooldown wait bounded by the retry budget', () => {
  let coordinator: InProcessThrottleCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new InProcessThrottleCoordinator();
  });

  afterEach(() => {
    coordinator.clear();
    vi.useRealTimers();
  });

  it('fails with ThrottledError when another owner cooldown outlasts the budget, without calling Graph', async () => {
    coordinator.raise(POOL, 60 * MINUTE_MS);
    const fn = vi.fn().mockResolvedValue('ok');

    const promise = run_with_throttle_coordinator(coordinator, POOL, () =>
      with_graph_retry(fn),
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(24 * MINUTE_MS);

    expect(await promise).toBeInstanceOf(ThrottledError);
    expect(fn).not.toHaveBeenCalled();
  });
});
