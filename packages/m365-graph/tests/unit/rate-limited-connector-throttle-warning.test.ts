import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/outlook/connector.port';
import { ThrottledError } from '@wisecom/atlas-types';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { with_graph_retry } from '@/graph-request-error-handler';
import { is_retry_after_above_cap_error } from '@/graph-retry-after';

/**
 * Issue #873. A Retry-After above the 1-hour cap fails the call on its first response, yet the
 * Outlook decorator warned that Graph "kept throttling mailbox ... through the retry budget" for
 * every ThrottledError. The warning now names only a budget that was spent.
 */
const MAILBOX = 'mailbox-a';

function throttled(retry_after_seconds: string): Record<string, unknown> {
  return {
    statusCode: 429,
    message: 'Too Many Requests',
    headers: new Headers({ 'retry-after': retry_after_seconds }),
  };
}

describe('RateLimitedGraphConnector throttle warning', () => {
  let throttle: InProcessThrottleCoordinator;
  let connector: RateLimitedGraphConnector;
  let warn: ReturnType<typeof vi.spyOn>;

  function wrap(list_mail_folders: MailboxConnector['list_mail_folders']): void {
    connector = new RateLimitedGraphConnector(
      { list_mail_folders } as MailboxConnector,
      new DefaultMailboxRateLimiterFactory(),
      throttle,
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    throttle = new InProcessThrottleCoordinator();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    connector.shutdown();
    throttle.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not warn about a retry budget when Retry-After above the cap failed the first attempt', async () => {
    const send = vi.fn(() => Promise.reject(throttled('3700')));
    wrap(() => with_graph_retry(send));

    const failure = await connector.list_mail_folders('t', MAILBOX).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ThrottledError);
    expect(is_retry_after_above_cap_error(failure)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    // The mailbox still cools down for the capped hour, so other requests to it keep waiting.
    expect(throttle.is_cooling('outlook', { ownerId: MAILBOX })).toBe(true);
  });

  it('still warns when the retry budget ran out', async () => {
    const exhausted = new ThrottledError('kept throttling after 12 retries', 30_000);
    wrap(() => Promise.reject(exhausted));

    await expect(connector.list_mail_folders('t', MAILBOX)).rejects.toBe(exhausted);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('through the retry budget'));
  });
});

describe('is_retry_after_above_cap_error', () => {
  it('is true only for a ThrottledError carrying a Retry-After above the hour', () => {
    expect(is_retry_after_above_cap_error(new ThrottledError('x', 3_700_000))).toBe(true);
    expect(is_retry_after_above_cap_error(new ThrottledError('x', 3_600_000))).toBe(false);
    expect(is_retry_after_above_cap_error(new ThrottledError('x'))).toBe(false);
    expect(is_retry_after_above_cap_error({ retry_after_ms: 3_700_000 })).toBe(false);
  });
});
