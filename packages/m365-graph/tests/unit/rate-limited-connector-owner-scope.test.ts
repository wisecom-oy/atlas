import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/mail/connector.port';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { with_graph_retry } from '@/graph-request-error-handler';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';

function throttled(): Error {
  return Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
}

/**
 * Mailbox A is throttled once by Graph; mailbox B never is. Each call goes through the real retry
 * loop, so the 429 reaches the coordinator through the same path production requests take.
 */
function connector_throttling_only(owner_to_throttle: string): RateLimitedGraphConnector {
  let throttled_once = false;
  const inner = {
    list_mail_folders: async (_tenant: string, owner: string) =>
      with_graph_retry(async () => {
        if (owner === owner_to_throttle && !throttled_once) {
          throttled_once = true;
          throw throttled();
        }
        return [];
      }),
  } as unknown as MailboxConnector;
  const throttle = new InProcessThrottleCoordinator();
  return new RateLimitedGraphConnector(
    inner,
    new DefaultMailboxRateLimiterFactory(throttle),
    throttle,
  );
}

/**
 * Issue #570. A 429 on one mailbox used to put the whole Outlook pool on cooldown, so an
 * unrelated mailbox waited out a throttle it did not cause.
 */
describe('RateLimitedGraphConnector per-mailbox throttle scope', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not delay mailbox B while mailbox A waits out its 429', async () => {
    const connector = connector_throttling_only('Mailbox-A');

    const a = connector.list_mail_folders('t', 'Mailbox-A');
    await vi.advanceTimersByTimeAsync(0);

    let b_done = false;
    void connector.list_mail_folders('t', 'mailbox-b').then(() => (b_done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(b_done).toBe(true);

    let a_done = false;
    void a.then(() => (a_done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(a_done).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(a_done).toBe(true);
    connector.shutdown();
  });

  it('keeps identity requests on the tenant-wide cooldown, even when made for one mailbox', async () => {
    // Graph meters the identity pool per tenant, so a mailbox scope there would split its budget.
    let throttled_once = false;
    const inner = {
      mailbox_exists: async () =>
        with_graph_retry(async () => {
          if (!throttled_once) {
            throttled_once = true;
            throw throttled();
          }
          return true;
        }),
    } as unknown as MailboxConnector;
    const throttle = new InProcessThrottleCoordinator();
    const wait = vi.spyOn(throttle, 'wait');
    const raise = vi.spyOn(throttle, 'raise');
    const connector = new RateLimitedGraphConnector(
      inner,
      new DefaultMailboxRateLimiterFactory(throttle),
      throttle,
    );

    const exists = connector.mailbox_exists('t', 'Mailbox-A');
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(exists).resolves.toBe(true);
    expect(raise).toHaveBeenCalledWith('identity', expect.any(Number), undefined);
    expect(wait).toHaveBeenCalledWith('identity', undefined);
    connector.shutdown();
  });
});
