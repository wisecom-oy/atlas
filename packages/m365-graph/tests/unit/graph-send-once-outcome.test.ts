/**
 * Issue #893: a create sent once that Graph may have committed reads differently from one Graph
 * refused. `with_graph_retry` throws `CreateOutcomeUnknownError` for the first and the refusal
 * unchanged for the second, and still retries a throttle response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateOutcomeUnknownError,
  GraphUnavailableError,
  ThrottledError,
  WriteOutcomeUnknownError,
} from '@wisecom/atlas-types';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { with_graph_retry } from '@/graph-request-error-handler';
import { leaves_create_outcome_unknown } from '@/graph-send-once-outcome';
import { RequestNotSentError } from '@/graph-attempt';

const CREATE_ONCE = { idempotent: false, complete_in_flight: true } as const;

function graph_error(status: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(`HTTP ${status}`), { statusCode: status, headers });
}

function failing_once(err: unknown): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  const fn = (): Promise<string> => {
    calls++;
    return calls === 1 ? Promise.reject(err) : Promise.resolve('created');
  };
  return { fn, calls: () => calls };
}

async function settle(fn: () => Promise<string>): Promise<unknown> {
  const outcome = with_graph_retry(fn, CREATE_ONCE).catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(600_000);
  return outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a create sent once that ended without a clear answer', () => {
  it.each([
    ['500', graph_error(500)],
    ['502', graph_error(502)],
    ['504', graph_error(504)],
    ['503 without Retry-After', graph_error(503)],
    ['dropped connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('is an unknown outcome after a %s, sent once, keeping the answer', async (_label, err) => {
    const { fn, calls } = failing_once(err);

    const outcome = await settle(fn);

    expect(outcome).toBeInstanceOf(CreateOutcomeUnknownError);
    expect(outcome).toBeInstanceOf(WriteOutcomeUnknownError);
    expect((outcome as Error).message).toMatch(/^outcome unknown, the item may exist: .*HTTP|hang/);
    expect((outcome as Error).cause).toBe(err);
    expect(calls()).toBe(1);
  });

  it('is an unknown outcome when the attempt times out', async () => {
    const fn = vi.fn((): Promise<string> => Promise.withResolvers<string>().promise);

    const outcome = with_graph_retry(fn, { ...CREATE_ONCE, timeout_ms: 5_000 }).catch(
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await outcome).toBeInstanceOf(CreateOutcomeUnknownError);
    expect(((await outcome) as Error).cause).toMatchObject({ code: 'ETIMEDOUT' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stays an unknown outcome when the run was cancelled while the create was in flight', async () => {
    const controller = new AbortController();
    const answer = Promise.withResolvers<string>();
    const fn = (): Promise<string> => answer.promise;

    const outcome = run_with_abort_signal(controller.signal, () =>
      with_graph_retry(fn, CREATE_ONCE),
    ).catch((err: unknown) => err);
    controller.abort(new Error('cancelled by operator'));
    answer.reject(graph_error(504));

    expect(await outcome).toBeInstanceOf(CreateOutcomeUnknownError);
  });
});

describe('a create Graph refused', () => {
  it.each([400, 403, 404, 409, 413])(
    'rethrows a %i unchanged after one attempt',
    async (status) => {
      const err = graph_error(status);
      const { fn, calls } = failing_once(err);

      expect(await settle(fn)).toBe(err);
      expect(calls()).toBe(1);
    },
  );
});

describe('a create Graph throttled', () => {
  it.each([
    ['429', graph_error(429)],
    ['503 with Retry-After', graph_error(503, { 'retry-after': '1' })],
  ])('retries a %s and never reports it as unknown', async (_label, err) => {
    const { fn, calls } = failing_once(err);

    expect(await settle(fn)).toBe('created');
    expect(calls()).toBe(2);
  });

  it('reports a throttle that outlasted the budget as ThrottledError, not as unknown', async () => {
    const fn = (): Promise<string> => Promise.reject(graph_error(429, { 'retry-after': '1' }));

    const outcome = await settle(fn);

    expect(outcome).toBeInstanceOf(ThrottledError);
    expect(outcome).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });
});

describe('leaves_create_outcome_unknown', () => {
  it('is false for a request that was never sent', () => {
    expect(leaves_create_outcome_unknown(new RequestNotSentError(graph_error(500)))).toBe(false);
  });

  it('is false for an inner call that already spent its budget', () => {
    const exhausted = new GraphUnavailableError('down', { retries: 12, elapsed_ms: 1 });
    expect(leaves_create_outcome_unknown(exhausted)).toBe(false);
    expect(leaves_create_outcome_unknown(new ThrottledError('slow down'))).toBe(false);
  });

  it('is true for a 408 and a 509, which can follow a commit', () => {
    expect(leaves_create_outcome_unknown(graph_error(408))).toBe(true);
    expect(leaves_create_outcome_unknown(graph_error(509))).toBe(true);
  });

  it('is false for a 401, which is a refused token', () => {
    expect(leaves_create_outcome_unknown(graph_error(401))).toBe(false);
  });
});
