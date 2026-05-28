import { describe, it, expect, vi } from 'vitest';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import { RateLimitedGraphConnector } from '@/adapters/m365/rate-limited-graph-connector.adapter';
import { CostTrackingRestoreConnector } from '@/adapters/m365/cost-tracking-restore-connector.adapter';
import { run_with_cost_tracking } from '@/services/shared/graph-request-context';
import { ThrottleFence } from '@/services/shared/throttle-fence';
import { DefaultMailboxRateLimiterFactory } from '@/services/shared/mailbox-rate-limiter';

function make_mock_mailbox_connector(): MailboxConnector {
  return {
    list_mailboxes: vi.fn().mockResolvedValue(['mb1']),
    mailbox_exists: vi.fn().mockResolvedValue(true),
    list_mail_folders: vi.fn().mockResolvedValue([]),
    fetch_delta: vi.fn().mockResolvedValue({
      messages: [],
      removed_ids: [],
      delta_link: 'https://example.com/delta',
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

function make_mock_restore_connector(): RestoreConnector {
  return {
    create_mail_folder: vi
      .fn()
      .mockResolvedValue({ folder_id: 'f1', display_name: 'Test', total_item_count: 0 }),
    create_message: vi.fn().mockResolvedValue('msg-id'),
    add_attachment: vi.fn().mockResolvedValue(undefined),
    create_upload_session: vi
      .fn()
      .mockResolvedValue({ upload_url: 'https://upload', expiration: '' }),
    upload_attachment_chunk: vi.fn().mockResolvedValue(undefined),
    count_folder_messages: vi.fn().mockResolvedValue(0),
    list_folder_messages: vi.fn().mockResolvedValue([]),
  };
}

describe('RateLimitedGraphConnector cost recording', () => {
  it('records list_mailboxes to identity pool', async () => {
    const inner = make_mock_mailbox_connector();
    const connector = make_rate_limited(inner);

    const [, cost] = await run_with_cost_tracking(() => connector.list_mailboxes('tenant'));

    expect(cost.by_service.identity?.requests).toBe(1);
    expect(cost.requests_by_type['list_users']).toBe(1);
    expect(cost.by_service.outlook).toBeUndefined();
  });

  it('records mailbox_exists to identity pool', async () => {
    const inner = make_mock_mailbox_connector();
    const connector = make_rate_limited(inner);

    const [, cost] = await run_with_cost_tracking(() =>
      connector.mailbox_exists('tenant', 'mailbox@example.com'),
    );

    expect(cost.by_service.identity?.requests).toBe(1);
    expect(cost.requests_by_type['mailbox_exists']).toBe(1);
    expect(cost.by_service.outlook).toBeUndefined();
  });

  it('records list_mail_folders to outlook pool', async () => {
    const inner = make_mock_mailbox_connector();
    const connector = make_rate_limited(inner);

    const [, cost] = await run_with_cost_tracking(() =>
      connector.list_mail_folders('tenant', 'mailbox@example.com'),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['list_folders']).toBe(1);
    expect(cost.by_service.identity).toBeUndefined();
  });

  it('records fetch_delta to outlook pool', async () => {
    const inner = make_mock_mailbox_connector();
    const connector = make_rate_limited(inner);

    const [, cost] = await run_with_cost_tracking(() =>
      connector.fetch_delta('tenant', 'mailbox@example.com', 'folder-id'),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['delta_sync']).toBe(1);
  });

  it('records fetch_attachments to outlook pool', async () => {
    const inner = make_mock_mailbox_connector();
    const connector = make_rate_limited(inner);

    const [, cost] = await run_with_cost_tracking(() =>
      connector.fetch_attachments('tenant', 'mailbox@example.com', 'msg-id'),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['fetch_attachments']).toBe(1);
  });

  it('records nothing when called outside a tracking context', async () => {
    const inner = make_mock_mailbox_connector();
    const connector = make_rate_limited(inner);

    await expect(
      connector.list_mail_folders('tenant', 'mailbox@example.com'),
    ).resolves.toBeDefined();
  });
});

describe('CostTrackingRestoreConnector cost recording', () => {
  it('records create_mail_folder to outlook pool', async () => {
    const inner = make_mock_restore_connector();
    const connector = new CostTrackingRestoreConnector(inner);

    const [, cost] = await run_with_cost_tracking(() =>
      connector.create_mail_folder('tenant', 'mailbox', 'FolderName'),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['create_folder']).toBe(1);
  });

  it('records create_message to outlook pool', async () => {
    const inner = make_mock_restore_connector();
    const connector = new CostTrackingRestoreConnector(inner);

    const [, cost] = await run_with_cost_tracking(() =>
      connector.create_message('tenant', 'mailbox', 'folder-id', {}),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.requests_by_type['create_message']).toBe(1);
  });

  it('records add_attachment with upload_bytes', async () => {
    const inner = make_mock_restore_connector();
    const connector = new CostTrackingRestoreConnector(inner);

    const attachment = {
      name: 'file.pdf',
      content_type: 'application/pdf',
      content: Buffer.alloc(512),
      is_inline: false,
      content_id: '',
    };

    const [, cost] = await run_with_cost_tracking(() =>
      connector.add_attachment('tenant', 'mailbox', 'msg-id', attachment),
    );

    expect(cost.by_service.outlook?.requests).toBe(1);
    expect(cost.by_service.outlook?.upload_bytes).toBe(512);
    expect(cost.requests_by_type['add_attachment']).toBe(1);
  });

  it('records upload_chunk with upload_bytes', async () => {
    const inner = make_mock_restore_connector();
    const connector = new CostTrackingRestoreConnector(inner);

    const chunk = Buffer.alloc(4 * 1024 * 1024);

    const [, cost] = await run_with_cost_tracking(() =>
      connector.upload_attachment_chunk('https://upload-url', chunk, 0, chunk.length),
    );

    expect(cost.by_service.outlook?.upload_bytes).toBe(4 * 1024 * 1024);
    expect(cost.requests_by_type['upload_chunk']).toBe(1);
  });

  it('accumulates multiple restore calls correctly', async () => {
    const inner = make_mock_restore_connector();
    const connector = new CostTrackingRestoreConnector(inner);

    const [, cost] = await run_with_cost_tracking(async () => {
      await connector.create_mail_folder('tenant', 'mailbox', 'Restore-2026');
      await connector.create_message('tenant', 'mailbox', 'f1', {});
      await connector.create_message('tenant', 'mailbox', 'f1', {});
      await connector.count_folder_messages('tenant', 'mailbox', 'f1');
    });

    expect(cost.requests_total).toBe(4);
    expect(cost.by_service.outlook?.requests).toBe(4);
    expect(cost.requests_by_type['create_folder']).toBe(1);
    expect(cost.requests_by_type['create_message']).toBe(2);
    expect(cost.requests_by_type['count_folder_messages']).toBe(1);
  });
});
