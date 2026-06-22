import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rethrow_if_access_denied,
  rethrow_if_mailbox_not_licensed,
  is_invalid_delta_error,
  is_transient_error,
  is_network_error,
  is_retryable_error,
  with_graph_retry,
} from '@/graph-error-helpers';

describe('rethrow_if_mailbox_not_licensed', () => {
  it('throws with actionable message when error code is MailboxNotEnabledForRESTAPI', () => {
    const err = { code: 'MailboxNotEnabledForRESTAPI', statusCode: 403, message: '' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).toThrow('not licensed for API access');
  });

  it('throws when MailboxNotEnabledForRESTAPI appears in error message', () => {
    const err = new Error('The mailbox is not enabled (MailboxNotEnabledForRESTAPI)');

    expect(() => rethrow_if_mailbox_not_licensed(err)).toThrow(
      'Reassign an Exchange Online license',
    );
  });

  it('does not throw for unrelated errors', () => {
    const err = { code: 'ErrorItemNotFound', statusCode: 404, message: 'Not found' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).not.toThrow();
  });

  it('does not throw for access denied errors (handled separately)', () => {
    const err = { code: 'ErrorAccessDenied', statusCode: 403, message: 'Forbidden' };

    expect(() => rethrow_if_mailbox_not_licensed(err)).not.toThrow();
  });
});

describe('rethrow_if_access_denied', () => {
  it('throws with permission guidance on 403', () => {
    const err = { statusCode: 403 };

    expect(() => rethrow_if_access_denied(err)).toThrow('403 Forbidden');
  });

  it('does not throw for non-403 errors', () => {
    const err = { statusCode: 404 };

    expect(() => rethrow_if_access_denied(err)).not.toThrow();
  });
});

describe('is_invalid_delta_error', () => {
  it('detects syncStateNotFound', () => {
    expect(is_invalid_delta_error(new Error('SyncStateNotFound'))).toBe(true);
  });

  it('detects resyncRequired', () => {
    expect(is_invalid_delta_error(new Error('resyncRequired'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(is_invalid_delta_error(new Error('timeout'))).toBe(false);
  });
});

describe('is_transient_error', () => {
  it.each([429, 503, 504])('returns true for status %i', (status) => {
    expect(is_transient_error({ statusCode: status })).toBe(true);
  });

  it('returns false for 400', () => {
    expect(is_transient_error({ statusCode: 400 })).toBe(false);
  });
});

describe('is_network_error', () => {
  it.each(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'])(
    'returns true for error code %s',
    (code) => {
      expect(is_network_error({ code })).toBe(true);
    },
  );

  it('returns true for "socket hang up" message', () => {
    expect(is_network_error(new Error('socket hang up'))).toBe(true);
  });

  it('returns true for "fetch failed" message', () => {
    expect(is_network_error(new Error('fetch failed'))).toBe(true);
  });

  it('returns true for ECONNRESET in error message', () => {
    expect(is_network_error(new Error('read ECONNRESET'))).toBe(true);
  });

  it('returns true for "terminated" message', () => {
    expect(is_network_error(new Error('terminated'))).toBe(true);
  });

  it('returns true for "aborted" message', () => {
    expect(is_network_error(new Error('The operation was aborted'))).toBe(true);
  });

  it('returns true for "client network socket disconnected" message', () => {
    expect(is_network_error(new Error('Client network socket disconnected'))).toBe(true);
  });

  it('returns false for a 404 HTTP error', () => {
    expect(is_network_error({ statusCode: 404 })).toBe(false);
  });

  it('returns false for a business logic error', () => {
    expect(is_network_error(new Error('Mailbox not found'))).toBe(false);
  });
});

describe('is_retryable_error', () => {
  it('returns true for transient HTTP errors', () => {
    expect(is_retryable_error({ statusCode: 429 })).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(is_retryable_error({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('returns false for non-retryable errors', () => {
    expect(is_retryable_error({ statusCode: 400 })).toBe(false);
  });
});

describe('with_graph_retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first success', async () => {
    const result = await with_graph_retry(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('retries on transient HTTP error and succeeds', async () => {
    let calls = 0;
    const fn = (): Promise<string> => {
      calls++;
      if (calls === 1) return Promise.reject({ statusCode: 503, message: 'Service Unavailable' });
      return Promise.resolve('recovered');
    };

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('retries on network error and succeeds', async () => {
    let calls = 0;
    const fn = (): Promise<string> => {
      calls++;
      if (calls <= 2) {
        const err = new Error('socket hang up');
        (err as Record<string, unknown>).code = 'ECONNRESET';
        return Promise.reject(err);
      }
      return Promise.resolve('recovered');
    };

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws non-retryable error immediately without retrying', async () => {
    const fn = vi.fn().mockRejectedValue({ statusCode: 400, message: 'Bad Request' });

    await expect(with_graph_retry(fn)).rejects.toEqual({
      statusCode: 400,
      message: 'Bad Request',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const err = { statusCode: 429, message: 'Too Many Requests' };
    const fn = vi.fn().mockRejectedValue(err);

    const promise = with_graph_retry(fn).catch((e: unknown) => e);
    for (let i = 0; i < 13; i++) {
      await vi.advanceTimersByTimeAsync(300_000);
    }

    const result = await promise;
    expect(result).toEqual(err);
    expect(fn).toHaveBeenCalledTimes(13);
  });

  it('retries on "terminated" error and succeeds', async () => {
    let calls = 0;
    const fn = (): Promise<string> => {
      calls++;
      if (calls <= 3) return Promise.reject(new Error('terminated'));
      return Promise.resolve('recovered');
    };

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(calls).toBe(4);
  });

  it('succeeds when request resolves before the 60s timeout', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await with_graph_retry(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds when request resolves within the 60s timeout window', async () => {
    const fn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('ok'), 5_000);
        }),
    );

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on ETIMEDOUT error', async () => {
    let calls = 0;
    const fn = (): Promise<string> => {
      calls++;
      if (calls === 1) {
        return Promise.reject(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
      }
      return Promise.resolve('recovered');
    };

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('respects Retry-After header', async () => {
    let calls = 0;
    const fn = (): Promise<string> => {
      calls++;
      if (calls === 1) {
        return Promise.reject({ statusCode: 429, headers: { 'retry-after': '2' } });
      }
      return Promise.resolve('ok');
    };

    const promise = with_graph_retry(fn);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});
