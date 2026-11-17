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
import {
  run_with_abort_signal,
  run_with_throttle_coordinator,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
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

  it('waits the Retry-After value plus at most one second of jitter before the next attempt', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(throttled('1'))
      .mockResolvedValue('ok');

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('fails with ThrottledError naming the value when Retry-After exceeds the 1 hour cap', async () => {
    const err = throttled('7200');
    const fn = vi.fn().mockRejectedValue(err);

    const result = await with_graph_retry(fn).catch((e: unknown) => e);

    expect(result).toBeInstanceOf(ThrottledError);
    expect(result).toMatchObject({
      code: 'ATLAS_THROTTLED',
      retry_after_ms: 7_200_000,
      cause: err,
    });
    expect((result as Error).message).toContain('7200 s');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('starts no new wait once 24 minutes have been waited', async () => {
    const fn = vi.fn().mockRejectedValue(throttled('300'));

    const promise = with_graph_retry(fn).catch((e: unknown) => e);
    // Attempts land at about 0, 5, 10, 15, 20 and 25 minutes. After the sixth, 25 minutes of
    // waiting have passed the 24 minute budget, so no seventh wait starts.
    await vi.advanceTimersByTimeAsync(26 * MINUTE_MS);

    expect(await promise).toBeInstanceOf(ThrottledError);
    expect(fn).toHaveBeenCalledTimes(6);
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

  it('waits out a one hour cooldown another owner raised, then sends', async () => {
    coordinator.raise(POOL, 60 * MINUTE_MS);
    const fn = vi.fn().mockResolvedValue('ok');

    const promise = run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS - 1);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_001);
    await expect(promise).resolves.toBe('ok');
  });

  it('fails with ThrottledError when a cooldown outlasts the 1 hour cap, without calling Graph', async () => {
    // A host coordinator can hold a cooldown longer than Atlas ever raises; the in-process fence does not clamp.
    coordinator.raise(POOL, 120 * MINUTE_MS);
    const fn = vi.fn().mockResolvedValue('ok');

    const promise = run_with_throttle_coordinator(coordinator, POOL, () =>
      with_graph_retry(fn),
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(61 * MINUTE_MS);

    expect(await promise).toBeInstanceOf(ThrottledError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('with_graph_retry budget counts waits, not time inside attempts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps retrying after a 25 minute attempt, because only the 1 second wait counts', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        const { promise, reject } = Promise.withResolvers<string>();
        setTimeout(() => reject(throttled('1')), 25 * MINUTE_MS);
        return promise;
      })
      .mockResolvedValue('ok');

    const promise = with_graph_retry(fn, { timeout_ms: 30 * MINUTE_MS });
    // The 1 second Retry-After plus at most 1 second of jitter.
    await vi.advanceTimersByTimeAsync(25 * MINUTE_MS + 2_000);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('with_graph_retry Retry-After of zero', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits at least one second, with jitter, instead of retrying at once', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(throttled('0'))
      .mockResolvedValue('ok');

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('raises the pool cooldown for the floored wait, not for zero', async () => {
    const coordinator = new InProcessThrottleCoordinator();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(throttled('0'))
      .mockResolvedValue('ok');

    const promise = run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.is_cooling(POOL)).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe('ok');
    coordinator.clear();
  });
});

describe('with_graph_retry stops when the run is cancelled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops a cooldown wait as soon as the run is cancelled', async () => {
    const coordinator = new InProcessThrottleCoordinator();
    coordinator.raise(POOL, 60 * MINUTE_MS);
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');
    const controller = new AbortController();

    const promise = run_with_abort_signal(controller.signal, () =>
      run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(fn)),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('run cancelled'));

    await expect(promise).rejects.toThrow('run cancelled');
    expect(fn).not.toHaveBeenCalled();
    coordinator.clear();
  });

  it('stops a retry sleep as soon as the run is cancelled, and clears its timer', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(throttled('30'));
    const controller = new AbortController();

    const promise = run_with_abort_signal(controller.signal, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('run cancelled'));

    await expect(promise).rejects.toThrow('run cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an attempt in flight without starting a retry', async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<string>();
    const fn = vi.fn<() => Promise<string>>(() => pending.promise);

    const promise = run_with_abort_signal(controller.signal, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('run cancelled'));

    await expect(promise).rejects.toThrow('run cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not start an attempt when the run was cancelled before it began', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');

    await expect(
      run_with_abort_signal(controller.signal, () => with_graph_retry(fn)),
    ).rejects.toThrow('run cancelled');
    expect(fn).not.toHaveBeenCalled();
  });

  it('clears the request timeout timer when the run is cancelled mid-attempt', async () => {
    const controller = new AbortController();
    const fn = vi.fn<() => Promise<string>>(() => new Promise<string>(() => undefined));

    const promise = run_with_abort_signal(controller.signal, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(new Error('run cancelled'));

    await expect(promise).rejects.toThrow('run cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the cooldown budget timer when the run is cancelled during a cooldown', async () => {
    const coordinator = new InProcessThrottleCoordinator();
    coordinator.raise(POOL, 60 * MINUTE_MS);
    // The fence owns its cooldown timer; only the timers the retry adds must be gone after abort.
    const fence_timers = vi.getTimerCount();
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');
    const controller = new AbortController();

    const promise = run_with_abort_signal(controller.signal, () =>
      run_with_throttle_coordinator(coordinator, POOL, () => with_graph_retry(fn)),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('run cancelled'));

    await expect(promise).rejects.toThrow('run cancelled');
    expect(vi.getTimerCount()).toBe(fence_timers);
    coordinator.clear();
  });

  it('clears the abort context for a nested run without a signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('outer run cancelled'));
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');

    const result = await run_with_abort_signal(controller.signal, () =>
      run_with_abort_signal(undefined, () => with_graph_retry(fn)),
    );
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
