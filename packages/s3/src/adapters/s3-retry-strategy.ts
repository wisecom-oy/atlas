import type { S3ClientConfig } from '@aws-sdk/client-s3';

/** The token-based retry strategy interface the SDK's retry middleware drives. */
export type S3RetryStrategy = Extract<
  NonNullable<S3ClientConfig['retryStrategy']>,
  { recordSuccess: unknown }
>;
type RetryToken = Awaited<ReturnType<S3RetryStrategy['acquireInitialRetryToken']>>;
type RetryErrorInfo = Parameters<S3RetryStrategy['refreshRetryTokenForRetry']>[1];

const BASE_DELAY_MS = 100;
const THROTTLING_BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 20_000;
/** How far past its own backoff a `Retry-After` hint may stretch one wait, as the SDK caps it. */
const MAX_RETRY_AFTER_EXTENSION_MS = 5_000;

/**
 * Retries each request on its own budget of `max_attempts`, with exponential backoff and full
 * jitter, and nothing shared between requests (issue #924).
 *
 * The SDK's standard and adaptive strategies share one token bucket per client: 500 tokens, 5 or 10
 * per retry, refilled by one per success. Atlas binds one client per process, so a burst of
 * failures early in a multi-hour run emptied the bucket and every later request failed on its
 * first error. Concurrency is already bounded by Atlas, so the amplification a bucket guards
 * against is at most `max_attempts` per request here.
 *
 * Retries only what the SDK classifies as throttling or transient: timeouts, connection errors,
 * 429, 500, 502, 503 and 504. A client error is never retried.
 */
export function create_s3_retry_strategy(
  max_attempts: number,
  random: () => number = Math.random,
): S3RetryStrategy {
  return {
    acquireInitialRetryToken: async (): Promise<RetryToken> => retry_token(0, 0),
    refreshRetryTokenForRetry: async (token, error_info): Promise<RetryToken> => {
      const retries_done = token.getRetryCount();
      if (!is_retryable(error_info) || retries_done + 1 >= max_attempts) {
        throw new Error('No retry token available');
      }
      return retry_token(retries_done + 1, backoff_delay_ms(retries_done, error_info, random));
    },
    recordSuccess: (): void => undefined,
  };
}

function retry_token(count: number, delay_ms: number): RetryToken {
  return { getRetryCount: () => count, getRetryDelay: () => delay_ms };
}

function is_retryable(error_info: RetryErrorInfo): boolean {
  return error_info.errorType === 'THROTTLING' || error_info.errorType === 'TRANSIENT';
}

/** Full-jitter exponential backoff, stretched toward a `Retry-After` hint by at most 5 s. */
function backoff_delay_ms(
  retries_done: number,
  error_info: RetryErrorInfo,
  random: () => number,
): number {
  const base = error_info.errorType === 'THROTTLING' ? THROTTLING_BASE_DELAY_MS : BASE_DELAY_MS;
  const jittered = Math.floor(random() * Math.min(base * 2 ** retries_done, MAX_DELAY_MS));
  const hint = error_info.retryAfterHint;
  if (!(hint instanceof Date)) return jittered;
  const hinted = Math.min(hint.getTime() - Date.now(), jittered + MAX_RETRY_AFTER_EXTENSION_MS);
  return Math.max(jittered, hinted);
}
