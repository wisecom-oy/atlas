import { describe, it, expect, vi } from 'vitest';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/mail/connector.port';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { ThrottleFence } from '@wisecom/atlas-core/services/shared/throttle-fence';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { run_with_cost_tracking } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { GRAPH_SERVICE_LIMITS } from '@wisecom/atlas-types';

function make_mailbox_stub(): MailboxConnector {
  return {
    list_mailboxes: vi.fn().mockResolvedValue(['mb1']),
    mailbox_exists: vi.fn().mockResolvedValue(true),
    list_mail_folders: vi.fn().mockResolvedValue([]),
    fetch_delta: vi.fn().mockResolvedValue({
      messages: [],
      removed_ids: [],
      delta_link: 'https://example.com/delta?token=abc',
      delta_reset: false,
    }),
    fetch_message: vi.fn().mockResolvedValue({}),
    fetch_attachments: vi.fn().mockResolvedValue([]),
  };
}

function make_rate_limited(inner: MailboxConnector): RateLimitedGraphConnector {
  const fence = new ThrottleFence();
  const factory = new DefaultMailboxRateLimiterFactory(fence);
  return new RateLimitedGraphConnector(inner, factory, fence);
}

describe('RateLimitedGraphConnector — pool attribution', () => {
  it('list_mailboxes records to identity pool with correct RU', async () => {
    const connector = make_rate_limited(make_mailbox_stub());
    const [, cost] = await run_with_cost_tracking(() => connector.list_mailboxes('tenant'));

    expect(cost.by_service.identity?.requests).toBe(1);
    expect(cost.by_service.identity?.resource_units).toBe(
      GRAPH_SERVICE_LIMITS.identity.users_list_cost,
    );
    expect(cost.requests_by_type['list_users']).toBe(1);
    expect(cost.by_service.outlook).toBeUndefined();
  });

  it('mailbox_exists records to identity pool', async () => {
    const connector = make_rate_limited(make_mailbox_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.mailbox_exists('tenant', 'user@example.com'),
    );

    expect(cost.by_service.identity?.requests).toBe(1);
    expect(cost.requests_by_type['mailbox_exists']).toBe(1);
    expect(cost.by_service.outlook).toBeUndefined();
  });

  it('list_mail_folders records to outlook pool', async () => {
    const connector = make_rate_limited(make_mailbox_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.list_mail_folders('tenant', 'user@example.com'),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['list_folders']).toBe(1);
    expect(cost.by_service.identity).toBeUndefined();
  });

  it('fetch_delta records to outlook pool', async () => {
    const connector = make_rate_limited(make_mailbox_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.fetch_delta('tenant', 'user@example.com', 'folder-id'),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['delta_sync']).toBe(1);
  });

  it('fetch_attachments records to outlook pool', async () => {
    const connector = make_rate_limited(make_mailbox_stub());
    const [, cost] = await run_with_cost_tracking(() =>
      connector.fetch_attachments('tenant', 'user@example.com', 'msg-id'),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['fetch_attachments']).toBe(1);
  });

  it('does not throw when called outside a tracking context', async () => {
    const connector = make_rate_limited(make_mailbox_stub());
    await expect(connector.list_mail_folders('tenant', 'user@example.com')).resolves.toBeDefined();
  });
});
