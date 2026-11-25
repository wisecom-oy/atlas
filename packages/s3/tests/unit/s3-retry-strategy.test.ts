import { afterEach, describe, expect, it, vi } from 'vitest';
import { create_s3_retry_strategy, type S3RetryStrategy } from '@/adapters/s3-retry-strategy';

// Issue #924: one shared token bucket let an early burst of failures disable retries for the rest
// of the process. Each request now has its own budget.

type ErrorInfo = Parameters<S3RetryStrategy['refreshRetryTokenForRetry']>[1];

const TRANSIENT: ErrorInfo = { errorType: 'TRANSIENT' };
const THROTTLING: ErrorInfo = { errorType: 'THROTTLING' };

/** Drives one request through every retry the strategy grants; returns the retries granted. */
async function exhaust(strategy: S3RetryStrategy, info: ErrorInfo): Promise<number> {
  let token = await strategy.acquireInitialRetryToken('');
  for (;;) {
    try {
      token = await strategy.refreshRetryTokenForRetry(token, info);
    } catch {
      return token.getRetryCount();
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('create_s3_retry_strategy', () => {
  it('grants max_attempts - 1 retries for a transient error', async () => {
    expect(
      await exhaust(
        create_s3_retry_strategy(3, () => 0),
        TRANSIENT,
      ),
    ).toBe(2);
    expect(
      await exhaust(
        create_s3_retry_strategy(1, () => 0),
        TRANSIENT,
      ),
    ).toBe(0);
  });

  it('still retries after a burst that would have drained the SDK bucket', async () => {
    const strategy = create_s3_retry_strategy(3, () => 0);
    // 500 tokens at 10 per transient retry: 50 retries emptied the SDK's bucket. Spend 1000.
    for (let request = 0; request < 500; request++) await exhaust(strategy, TRANSIENT);

    expect(await exhaust(strategy, TRANSIENT)).toBe(2);
    expect(await exhaust(strategy, THROTTLING)).toBe(2);
  });

  it.each(['CLIENT_ERROR', 'SERVER_ERROR'] as const)('never retries a %s', async (error_type) => {
    expect(await exhaust(create_s3_retry_strategy(3), { errorType: error_type })).toBe(0);
  });

  it('backs off exponentially with full jitter, from a longer base for throttling', async () => {
    const strategy = create_s3_retry_strategy(4, () => 0.5);
    const first = await strategy.refreshRetryTokenForRetry(
      await strategy.acquireInitialRetryToken(''),
      TRANSIENT,
    );
    const second = await strategy.refreshRetryTokenForRetry(first, TRANSIENT);
    const throttled = await strategy.refreshRetryTokenForRetry(first, THROTTLING);

    expect(first.getRetryDelay()).toBe(50);
    expect(second.getRetryDelay()).toBe(100);
    expect(throttled.getRetryDelay()).toBe(500);
  });

  it('caps the backoff at 20 seconds', async () => {
    const strategy = create_s3_retry_strategy(10, () => 1);
    let token = await strategy.acquireInitialRetryToken('');
    for (let retry = 0; retry < 9; retry++) {
      token = await strategy.refreshRetryTokenForRetry(token, THROTTLING);
    }

    expect(token.getRetryDelay()).toBe(20_000);
  });

  it('stretches a wait toward Retry-After by at most 5 seconds past its own backoff', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const strategy = create_s3_retry_strategy(3, () => 0);
    const initial = await strategy.acquireInitialRetryToken('');
    const near = await strategy.refreshRetryTokenForRetry(initial, {
      ...THROTTLING,
      retryAfterHint: new Date(Date.now() + 2_000),
    });
    const far = await strategy.refreshRetryTokenForRetry(initial, {
      ...THROTTLING,
      retryAfterHint: new Date(Date.now() + 60_000),
    });

    expect(near.getRetryDelay()).toBe(2_000);
    expect(far.getRetryDelay()).toBe(5_000);
  });
});
