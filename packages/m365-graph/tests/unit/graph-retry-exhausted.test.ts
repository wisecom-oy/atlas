import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AtlasError,
  GraphAccessRefusedError,
  GraphUnavailableError,
  ThrottledError,
} from '@wisecom/atlas-types';
import {
  is_retryable_error,
  is_transient_error,
  with_graph_retry,
} from '@/graph-request-error-handler';

/**
 * Issue #773: a transient failure that outlasts the retry budget is typed, so a caller can tell a
 * Microsoft outage from an unknown bug. Before, the last Graph error was rethrown as is, and a 5xx
 * with an empty body has an empty `message`.
 */

/** The shape the Graph SDK gives a 5xx whose body is empty or not JSON. */
function empty_body_graph_error(status: number): Error {
  return Object.assign(new Error(''), { statusCode: status, code: null, body: '' });
}

/** Runs `fn` through the retry loop until it gives up, and returns what it rejected with. */
async function exhaust(fn: () => Promise<unknown>): Promise<unknown> {
  const promise = with_graph_retry(fn).catch((e: unknown) => e);
  for (let i = 0; i < 13; i++) {
    await vi.advanceTimersByTimeAsync(300_000);
  }
  return await promise;
}

describe('with_graph_retry, exhausted failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([500, 502, 503, 504])(
    'raises GraphUnavailableError for a %i with an empty body',
    async (status) => {
      const err = empty_body_graph_error(status);
      const fn = vi.fn().mockRejectedValue(err);

      const failure = await exhaust(fn);

      expect(failure).toBeInstanceOf(GraphUnavailableError);
      expect(failure).toBeInstanceOf(AtlasError);
      expect(failure).toMatchObject({
        code: 'ATLAS_GRAPH_UNAVAILABLE',
        status_code: status,
        graph_code: undefined,
        retries: 12,
        cause: err,
      });
      const { message, elapsed_ms } = failure as GraphUnavailableError;
      expect(message).toMatch(/^Microsoft Graph was unavailable after 12 retries/);
      expect(message).toContain(`HTTP ${status}`);
      expect(elapsed_ms).toBeGreaterThan(0);
      expect(fn).toHaveBeenCalledTimes(13);
    },
  );

  it('keeps the Graph code when the 5xx body carried one', async () => {
    const err = Object.assign(new Error('The service is unavailable.'), {
      statusCode: 503,
      code: 'serviceNotAvailable',
    });

    const failure = await exhaust(vi.fn().mockRejectedValue(err));

    expect(failure).toMatchObject({ graph_code: 'serviceNotAvailable', status_code: 503 });
    expect((failure as Error).message).toContain('HTTP 503 -- serviceNotAvailable');
  });

  it('raises GraphUnavailableError without a status for a network error', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    const failure = await exhaust(vi.fn().mockRejectedValue(reset));

    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(failure).toMatchObject({
      status_code: undefined,
      graph_code: undefined,
      retries: 12,
      cause: reset,
    });
    expect((failure as Error).message).toContain('no HTTP response (ECONNRESET: read ECONNRESET)');
  });

  it('reports no status for the network failure the Graph SDK wraps as statusCode -1', async () => {
    // What the Graph SDK rejects with when fetch itself fails: the native error's name as `code`,
    // a status of -1, and no `cause`. Seen live under a connection-reset outage.
    const wrapped = Object.assign(new Error('fetch failed'), { statusCode: -1, code: 'TypeError' });

    const failure = await exhaust(vi.fn().mockRejectedValue(wrapped));

    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(failure).toMatchObject({
      status_code: undefined,
      graph_code: undefined,
      cause: wrapped,
    });
    const { message } = failure as Error;
    expect(message).toContain('no HTTP response (TypeError: fetch failed)');
    expect(message).not.toContain('HTTP -1');
  });

  it('still raises ThrottledError for an exhausted 429', async () => {
    const err = { statusCode: 429, message: '', headers: { 'retry-after': '2' } };

    const failure = await exhaust(vi.fn().mockRejectedValue(err));

    expect(failure).toBeInstanceOf(ThrottledError);
    expect(failure).not.toBeInstanceOf(GraphUnavailableError);
  });

  it('rethrows a non-retryable failure unchanged on the first attempt', async () => {
    const err = Object.assign(new Error(''), { statusCode: 400, code: 'BadRequest' });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(with_graph_retry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not wrap an exhausted failure an inner call already typed', async () => {
    const inner = new GraphUnavailableError('inner', { retries: 12, elapsed_ms: 1 });

    expect(await exhaust(vi.fn().mockRejectedValue(inner))).toBe(inner);
  });
});

describe('transient classification of the typed errors', () => {
  it('keeps an exhausted 5xx transient for an outer retry loop, as the raw 5xx was', () => {
    const unavailable = new GraphUnavailableError('down', { retries: 12, elapsed_ms: 1 });
    expect(is_transient_error(unavailable)).toBe(true);
    expect(is_retryable_error(unavailable)).toBe(true);
  });

  it('treats a refused resource as permanent', () => {
    const refused = new GraphAccessRefusedError('refused', { site_id: 's' }, 'access_refused', {
      status_code: 403,
    });
    expect(is_transient_error(refused)).toBe(false);
    expect(is_retryable_error(refused)).toBe(false);
  });
});
