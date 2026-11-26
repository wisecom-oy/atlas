/**
 * Issue #884. An Outlook call waited out its mailbox's cooldown in the limiter and then entered the
 * retry loop with an empty budget, so under a persistent 1-hour throttle one call waited two full
 * cooldowns. That wait now counts against the call's 24-minute budget; pacing waits still do not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/outlook/connector.port';
import { ThrottledError } from '@wisecom/atlas-types';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { with_graph_retry } from '@/graph-request-error-handler';
import { take_uncharged_wait_ms } from '@/graph-presend-cooldown';
import { MAX_COOLDOWN_WAIT_MS } from '@/graph-cooldown-wait';

const MAILBOX = 'mailbox-a';
const SCOPE = { ownerId: MAILBOX };
const HOUR_MS = 3_600_000;
const JITTER_MS = 5_000;
const WINDOW_MS = 600_000;

let throttle: InProcessThrottleCoordinator;
let connector: RateLimitedGraphConnector;

function throttled(retry_after_seconds: string): Record<string, unknown> {
  return {
    statusCode: 429,
    message: 'Too Many Requests',
    headers: new Headers({ 'retry-after': retry_after_seconds }),
  };
}

/** A connector whose folder listing runs `list`; `window` sizes the mailbox's request window. */
function build(list: () => Promise<unknown>, window?: number): void {
  connector = new RateLimitedGraphConnector(
    { list_mail_folders: list } as unknown as MailboxConnector,
    new DefaultMailboxRateLimiterFactory(window),
    throttle,
  );
}

/** Starts a listing and records when it settles, in fake milliseconds since the start. */
function list_and_time() {
  const started = Date.now();
  const state: { settled_after_ms?: number; error?: unknown } = {};
  void connector.list_mail_folders('t', MAILBOX).then(
    () => (state.settled_after_ms = Date.now() - started),
    (err: unknown) => Object.assign(state, { settled_after_ms: Date.now() - started, error: err }),
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  throttle = new InProcessThrottleCoordinator();
});

afterEach(() => {
  connector.shutdown();
  throttle.clear();
  vi.useRealTimers();
});

describe('RateLimitedGraphConnector cooldown wait before the send (issue #884)', () => {
  it('waits at most one cooldown in all under a persistent 1-hour throttle', async () => {
    const send = vi.fn(() => Promise.reject(throttled('3600')));
    build(() => with_graph_retry(send));
    throttle.raise('outlook', HOUR_MS, SCOPE);

    const listing = list_and_time();
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    // Sent once after the first cooldown; its 429 finds the budget spent, so no second hour.
    expect(send).toHaveBeenCalledOnce();
    expect(listing.error).toBeInstanceOf(ThrottledError);
    expect(listing.settled_after_ms).toBeLessThanOrEqual(HOUR_MS + JITTER_MS);
  });

  it('still waits out a short cooldown before the send, and keeps the retries after it', async () => {
    const send = vi
      .fn<() => Promise<unknown[]>>()
      .mockRejectedValueOnce(throttled('30'))
      .mockResolvedValueOnce([]);
    build(() => with_graph_retry(send));
    throttle.raise('outlook', 30_000, SCOPE);

    const listing = list_and_time();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(send).toHaveBeenCalledTimes(2);
    expect(listing.error).toBeUndefined();
  });

  it('charges the cooldown wait to the first Graph call the connector call makes, once', async () => {
    const charged: number[] = [];
    build(async () => {
      charged.push(take_uncharged_wait_ms(), take_uncharged_wait_ms());
      return [];
    });
    throttle.raise('outlook', 30_000, SCOPE);

    void connector.list_mail_folders('t', MAILBOX);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(charged[0]).toBeGreaterThanOrEqual(30_000);
    expect(charged[0]).toBeLessThanOrEqual(30_000 + JITTER_MS);
    expect(charged[1]).toBe(0);
  });

  it('charges nothing for a wait on the request window', async () => {
    const charged: number[] = [];
    build(async () => {
      charged.push(take_uncharged_wait_ms());
      return [];
    }, 1);

    await connector.list_mail_folders('t', MAILBOX);
    void connector.list_mail_folders('t', MAILBOX);
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1_000);

    expect(charged).toEqual([0, 0]);
  });

  it('fails without sending when other requests keep the cooldown up past one full wait', async () => {
    const send = vi.fn(() => Promise.resolve([]));
    build(() => with_graph_retry(send));
    throttle.raise('outlook', HOUR_MS, SCOPE);

    const listing = list_and_time();
    await vi.advanceTimersByTimeAsync(HOUR_MS - 60_000);
    throttle.raise('outlook', HOUR_MS, SCOPE);
    await vi.advanceTimersByTimeAsync(MAX_COOLDOWN_WAIT_MS - (HOUR_MS - 60_000));

    expect(send).not.toHaveBeenCalled();
    expect(listing.error).toBeInstanceOf(ThrottledError);
    expect(listing.settled_after_ms).toBe(MAX_COOLDOWN_WAIT_MS);
    expect(throttle.is_cooling('outlook', SCOPE)).toBe(true);
  });
});
