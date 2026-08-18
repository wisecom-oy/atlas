/**
 * The connector decorator declares what each call is doing; the transport
 * middleware turns that declaration into one cost record per HTTP request.
 * These tests cover the declaration half -- that every method runs its inner
 * call inside an operation scope carrying the right pool, label and RU.
 *
 * Asserting a request count here instead would be asserting a fiction: the
 * stub issues no HTTP request, and the real adapter issues many per call.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/mail/connector.port';
import type { GraphOperation } from '@wisecom/atlas-types';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { ThrottleFence } from '@wisecom/atlas-core/services/shared/throttle-fence';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { get_active_operation } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';

/** Captures the operation visible to the inner connector, i.e. to the transport. */
function make_capturing_stub(seen: GraphOperation[]): MailboxConnector {
  const capture =
    <T>(value: T) =>
    async () => {
      const op = get_active_operation();
      if (op) seen.push(op);
      return value;
    };
  return {
    list_mailboxes: vi.fn(capture(['mb1'])),
    mailbox_exists: vi.fn(capture(true)),
    get_mailbox_purpose: vi.fn(capture('user')),
    list_mail_folders: vi.fn(capture([])),
    fetch_delta: vi.fn(
      capture({ messages: [], removed_ids: [], delta_link: 'https://x/delta', delta_reset: false }),
    ),
    fetch_message: vi.fn(capture({})),
    fetch_attachments: vi.fn(capture([])),
  } as unknown as MailboxConnector;
}

function make_rate_limited(inner: MailboxConnector): RateLimitedGraphConnector {
  const fence = new ThrottleFence();
  const factory = new DefaultMailboxRateLimiterFactory(fence);
  return new RateLimitedGraphConnector(inner, factory, fence);
}

describe('RateLimitedGraphConnector — operation labelling', () => {
  it('labels list_mailboxes as an identity call carrying the list RU cost', async () => {
    const seen: GraphOperation[] = [];
    await make_rate_limited(make_capturing_stub(seen)).list_mailboxes('tenant');

    expect(seen).toEqual([
      {
        pool: 'identity',
        request_type: 'list_users',
        resource_units: GRAPH_SERVICE_LIMITS.identity.users_list_cost,
      },
    ]);
  });

  it('labels mailbox_exists as an identity call carrying the get RU cost', async () => {
    const seen: GraphOperation[] = [];
    await make_rate_limited(make_capturing_stub(seen)).mailbox_exists('tenant', 'user@example.com');

    expect(seen[0]?.pool).toBe('identity');
    expect(seen[0]?.request_type).toBe('mailbox_exists');
    expect(seen[0]?.resource_units).toBe(GRAPH_SERVICE_LIMITS.identity.user_get_cost);
  });

  it('labels get_mailbox_purpose as an identity call', async () => {
    const seen: GraphOperation[] = [];
    await make_rate_limited(make_capturing_stub(seen)).get_mailbox_purpose!(
      'tenant',
      'user@example.com',
    );

    expect(seen[0]?.pool).toBe('identity');
    expect(seen[0]?.request_type).toBe('get_mailbox_purpose');
  });

  it.each([
    ['list_mail_folders', 'list_folders'],
    ['fetch_delta', 'delta_sync'],
    ['fetch_message', 'fetch_message'],
    ['fetch_attachments', 'fetch_attachments'],
  ])('labels %s as an outlook call typed %s', async (method, expected_type) => {
    const seen: GraphOperation[] = [];
    const connector = make_rate_limited(make_capturing_stub(seen));

    await (connector[method as 'fetch_message'] as (...a: string[]) => Promise<unknown>)(
      'tenant',
      'user@example.com',
      'id',
    );

    expect(seen[0]?.pool).toBe('outlook');
    expect(seen[0]?.request_type).toBe(expected_type);
    // Outlook is a flat-cost pool: RU per request equals 1, the default.
    expect(seen[0]?.resource_units).toBeUndefined();
  });

  it('leaves no operation in scope once the call returns', async () => {
    const seen: GraphOperation[] = [];
    await make_rate_limited(make_capturing_stub(seen)).list_mailboxes('tenant');

    expect(get_active_operation()).toBeUndefined();
  });
});
