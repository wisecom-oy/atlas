import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { GraphUnavailableError, ThrottledError } from '@wisecom/atlas-types';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import {
  is_retryable_error,
  is_throttle_response,
  is_transient_error,
  with_graph_retry,
} from '@/graph-request-error-handler';

/**
 * Issue #867: a Graph 408 is a timeout and a 509 is SharePoint's bandwidth throttle, so both are
 * retried within the budget, and a 509 backs the pool off like a 429. 423 and 507 stay
 * unretried: a lock and a full quota outlast any retry budget.
 */

/** `with_graph_retry` sends the first attempt and 12 retries. */
const MAX_ATTEMPTS = 13;
const CREATE_ONCE = { idempotent: false } as const;

function graph_error(status: number): Record<string, unknown> {
  return { statusCode: status, code: null, message: '', body: '' };
}

/** A call that fails once with `err`, then resolves. */
function failing_once(err: unknown): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  const fn = (): Promise<string> => {
    calls++;
    return calls === 1 ? Promise.reject(err) : Promise.resolve('second');
  };
  return { fn, calls: () => calls };
}

/** Runs `fn` through the retry loop until it settles, and returns what it settled with. */
async function settle(fn: () => Promise<unknown>, options = {}): Promise<unknown> {
  const promise = with_graph_retry(fn, options).catch((e: unknown) => e);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await vi.advanceTimersByTimeAsync(300_000);
  }
  return await promise;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status classification', () => {
  it.each([408, 509])('treats a %i as transient and retryable', (status) => {
    expect(is_transient_error(graph_error(status))).toBe(true);
    expect(is_retryable_error(graph_error(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 423, 501, 507])('does not retry a %i', (status) => {
    expect(is_transient_error(graph_error(status))).toBe(false);
    expect(is_retryable_error(graph_error(status))).toBe(false);
  });

  it.each([408, 509])('does not count a %i as safe to resend for a write', (status) => {
    expect(is_throttle_response(graph_error(status))).toBe(false);
  });
});

describe('with_graph_retry on a 408 or 509', () => {
  it.each([408, 509])('completes a read after one %i', async (status) => {
    const { fn, calls } = failing_once(graph_error(status));

    expect(await settle(fn)).toBe('second');
    expect(calls()).toBe(2);
  });

  it('raises GraphUnavailableError for a 408 that outlasts the budget', async () => {
    const fn = vi.fn().mockRejectedValue(graph_error(408));

    const failure = await settle(fn);

    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect((failure as GraphUnavailableError).code).toBe('ATLAS_GRAPH_UNAVAILABLE');
    expect((failure as GraphUnavailableError).status_code).toBe(408);
  });

  it('raises ThrottledError for a 509 that outlasts the budget', async () => {
    const fn = vi.fn().mockRejectedValue(graph_error(509));

    const failure = await settle(fn);

    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(failure).toBeInstanceOf(ThrottledError);
    expect((failure as ThrottledError).code).toBe('ATLAS_THROTTLED');
    expect((failure as ThrottledError).message).toContain('HTTP 509');
  });

  it.each([408, 509])('sends a write marked idempotent: false once on a %i', async (status) => {
    const err = graph_error(status);
    const { fn, calls } = failing_once(err);

    expect(await settle(fn, CREATE_ONCE)).toMatchObject({
      name: 'CreateOutcomeUnknownError',
      cause: err,
    });
    expect(calls()).toBe(1);
  });
});

describe('with_graph_retry on statuses it does not retry', () => {
  // A 401 is repeated once with a new token (issue #861); graph-unauthorized-retry tests cover it.
  it.each([400, 403, 404, 423, 507])(
    'rethrows a %i unchanged after one attempt',
    async (status) => {
      const err = graph_error(status);
      const { fn, calls } = failing_once(err);

      expect(await settle(fn)).toBe(err);
      expect(calls()).toBe(1);
    },
  );
});

describe('with_graph_retry and the pool cooldown', () => {
  let coordinator: RecordingThrottleCoordinator;

  beforeEach(() => {
    coordinator = recording_throttle_coordinator();
  });

  function run_in_pool(fn: () => Promise<string>): Promise<unknown> {
    return run_with_throttle_coordinator(coordinator, 'sharepoint_onedrive', () =>
      with_graph_retry(fn),
    ).catch((e: unknown) => e);
  }

  it('raises the 30 s default cooldown on the first 509, like a 429', async () => {
    const { fn } = failing_once(graph_error(509));

    const result = run_in_pool(fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 30_000]]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBe('second');
  });

  it('honours the Retry-After a 509 carries for the cooldown', async () => {
    const { fn } = failing_once({ ...graph_error(509), headers: { 'retry-after': '7' } });

    const result = run_in_pool(fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 7_000]]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBe('second');
  });

  it('raises no cooldown for a 408', async () => {
    const { fn } = failing_once(graph_error(408));

    const result = run_in_pool(fn);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await result).toBe('second');
    expect(coordinator.raises).toEqual([]);
  });
});
