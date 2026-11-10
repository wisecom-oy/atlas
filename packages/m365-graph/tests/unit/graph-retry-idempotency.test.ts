/**
 * Issue #624: a write Graph may already have applied is not sent twice. A call marked
 * `idempotent: false` is retried only on a throttle response, and a timed-out attempt is aborted
 * through the signal `fn` receives so it cannot commit beside its retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { is_throttle_response, with_graph_retry } from '@/graph-request-error-handler';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';

const CREATE_ONCE = { idempotent: false } as const;

function failing_once(err: unknown): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  const fn = (): Promise<string> => {
    calls++;
    return calls === 1 ? Promise.reject(err) : Promise.resolve('second');
  };
  return { fn, calls: () => calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('is_throttle_response', () => {
  it('accepts a 429 with or without Retry-After', () => {
    expect(is_throttle_response({ statusCode: 429 })).toBe(true);
    expect(is_throttle_response({ statusCode: 429, headers: { 'retry-after': '3' } })).toBe(true);
  });

  it('accepts a 503 only when it carries Retry-After', () => {
    expect(is_throttle_response({ statusCode: 503, headers: { 'retry-after': '3' } })).toBe(true);
    expect(is_throttle_response({ statusCode: 503 })).toBe(false);
  });

  it.each([500, 502, 504])('rejects a %i', (status) => {
    expect(is_throttle_response({ statusCode: status })).toBe(false);
  });

  it('rejects a network error', () => {
    expect(is_throttle_response(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      false,
    );
  });
});

describe('with_graph_retry with idempotent: false', () => {
  it.each([500, 502, 503, 504])('sends a write once when Graph answers %i', async (status) => {
    const err = { statusCode: status, message: 'Server error' };
    const { fn, calls } = failing_once(err);

    const outcome = with_graph_retry(fn, CREATE_ONCE).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toBe(err);
    expect(calls()).toBe(1);
  });

  it('sends a write once when the connection drops', async () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const { fn, calls } = failing_once(err);

    const outcome = with_graph_retry(fn, CREATE_ONCE).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toBe(err);
    expect(calls()).toBe(1);
  });

  it('sends a write once when the attempt times out, and aborts it', async () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn((signal: AbortSignal): Promise<string> => {
      signals.push(signal);
      return Promise.withResolvers<string>().promise;
    });

    const outcome = with_graph_retry(fn, { ...CREATE_ONCE, timeout_ms: 5_000 }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('still retries a 429, which Graph sends instead of processing the request', async () => {
    const { fn, calls } = failing_once({ statusCode: 429, headers: { 'retry-after': '2' } });

    const outcome = with_graph_retry(fn, CREATE_ONCE);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toBe('second');
    expect(calls()).toBe(2);
  });

  it('retries a 503 that carries Retry-After', async () => {
    const { fn, calls } = failing_once({ statusCode: 503, headers: { 'retry-after': '2' } });

    const outcome = with_graph_retry(fn, CREATE_ONCE);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toBe('second');
    expect(calls()).toBe(2);
  });
});

describe('with_graph_retry attempt signal', () => {
  it('aborts a timed-out attempt before the retry goes out', async () => {
    const seen: Array<{ signal: AbortSignal; aborted_at_retry?: boolean }> = [];
    const fn = (signal: AbortSignal): Promise<string> => {
      const previous = seen.at(-1);
      if (previous) previous.aborted_at_retry = previous.signal.aborted;
      seen.push({ signal });
      return seen.length === 1
        ? Promise.withResolvers<string>().promise
        : Promise.resolve('recovered');
    };

    const outcome = with_graph_retry(fn, { timeout_ms: 5_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toBe('recovered');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.aborted_at_retry).toBe(true);
    expect(seen[1]?.signal.aborted).toBe(false);
  });

  it('aborts the attempt when the run is cancelled', async () => {
    const controller = new AbortController();
    let attempt_signal: AbortSignal | undefined;
    const fn = (signal: AbortSignal): Promise<string> => {
      attempt_signal = signal;
      return Promise.withResolvers<string>().promise;
    };

    const outcome = run_with_abort_signal(controller.signal, () =>
      with_graph_retry(fn).catch((e: unknown) => e),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('cancelled by operator'));

    expect(await outcome).toMatchObject({ message: 'cancelled by operator' });
    expect(attempt_signal?.aborted).toBe(true);
  });
});
