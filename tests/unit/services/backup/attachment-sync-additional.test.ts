import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import {
  create_mailbox_sync_harness,
  make_delta,
  make_message,
} from './mailbox-sync-test-fixtures';

describe('MailboxSyncService - attachment backup (additional)', () => {
  let mock_connector: MailboxConnector;
  let mock_context: TenantContext;
  let sync_mailbox: ReturnType<typeof create_mailbox_sync_harness>['service']['sync_mailbox'];

  beforeEach(() => {
    const harness = create_mailbox_sync_harness();
    mock_connector = harness.mock_connector;
    mock_context = harness.mock_context;
    sync_mailbox = harness.service.sync_mailbox.bind(harness.service);
  });

  it('invokes on_progress callback during attachment processing', async () => {
    const msg = make_message('msg-cb', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-1',
        name: 'a.pdf',
        content_type: 'application/pdf',
        size_bytes: 100,
        is_inline: false,
        content: Buffer.from('pdf-a'),
        content_id: '',
      },
      {
        attachment_id: 'att-2',
        name: 'b.png',
        content_type: 'image/png',
        size_bytes: 200,
        is_inline: false,
        content: Buffer.from('png-b'),
        content_id: '',
      },
    ]);

    const result = await sync_mailbox('t', 'user@test.com');
    expect(result.manifest.entries[0]!.attachments).toHaveLength(2);
  });

  it('includes attachment sizes in manifest total_size_bytes', async () => {
    const msg = make_message('msg-size', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-sz',
        name: 'file.bin',
        content_type: 'application/octet-stream',
        size_bytes: 5000,
        is_inline: false,
        content: Buffer.from('bin-data'),
        content_id: '',
      },
    ]);

    const result = await sync_mailbox('t', 'user@test.com');

    const msg_size = msg.raw_body.length;
    expect(result.manifest.total_size_bytes).toBe(msg_size + 5000);
  });

  it('stores multiple attachments from a single message', async () => {
    const msg = make_message('msg-multi', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-a',
        name: 'a.pdf',
        content_type: 'application/pdf',
        size_bytes: 100,
        is_inline: false,
        content: Buffer.from('pdf-a'),
        content_id: '',
      },
      {
        attachment_id: 'att-b',
        name: 'b.png',
        content_type: 'image/png',
        size_bytes: 200,
        is_inline: true,
        content: Buffer.from('png-b'),
        content_id: 'image001.png@01DA3B2F',
      },
    ]);

    const result = await sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries[0]!.attachments).toHaveLength(2);
    expect(result.manifest.entries[0]!.attachments![0]!.name).toBe('a.pdf');
    expect(result.manifest.entries[0]!.attachments![1]!.name).toBe('b.png');
    expect(result.manifest.entries[0]!.attachments![1]!.is_inline).toBe(true);
    expect(result.manifest.entries[0]!.attachments![1]!.content_id).toBe('image001.png@01DA3B2F');
    expect(result.manifest.entries[0]!.attachments![0]!.content_id).toBeUndefined();
  });

  it('passes object lock policy to newly uploaded attachments', async () => {
    const msg = make_message('msg-lock', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-lock',
        name: 'locked.bin',
        content_type: 'application/octet-stream',
        size_bytes: 8,
        is_inline: false,
        content: Buffer.from('lockdata'),
        content_id: '',
      },
    ]);

    await sync_mailbox('t', 'user@test.com', {
      object_lock_policy: {
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      },
    });

    const att_put = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls.find(
      ([key]: [string]) => key.startsWith('attachments/'),
    );
    expect(att_put?.[3]).toEqual({
      mode: 'GOVERNANCE',
      retain_until: '2026-04-08T12:00:00.000Z',
    });
  });
});
