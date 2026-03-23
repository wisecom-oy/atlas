import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { TenantContext } from '@/ports/tenant/context.port';
import {
  create_mailbox_sync_harness,
  make_delta,
  make_message,
} from './mailbox-sync-test-fixtures';

describe('MailboxSyncService - attachment backup (core)', () => {
  let mock_connector: MailboxConnector;
  let mock_context: TenantContext;
  let sync_mailbox: ReturnType<typeof create_mailbox_sync_harness>['service']['sync_mailbox'];

  beforeEach(() => {
    const harness = create_mailbox_sync_harness();
    mock_connector = harness.mock_connector;
    mock_context = harness.mock_context;
    sync_mailbox = harness.service.sync_mailbox.bind(harness.service);
  });

  it('fetches and stores attachments for messages with has_attachments=true', async () => {
    const msg = make_message('msg-att', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-1',
        name: 'report.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
        is_inline: false,
        content: Buffer.from('pdf-content'),
        content_id: '',
      },
    ]);

    const result = await sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_attachments).toHaveBeenCalledWith('t', 'user@test.com', 'msg-att');
    expect(result.manifest.entries[0]!.attachments).toHaveLength(1);
    expect(result.manifest.entries[0]!.attachments![0]!.name).toBe('report.pdf');
    expect(result.manifest.entries[0]!.attachments![0]!.storage_key).toContain(
      'attachments/user@test.com/',
    );
  });

  it('skips fetch_attachments for messages without attachments', async () => {
    const msg = make_message('msg-no-att', 'body', false);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));

    const result = await sync_mailbox('t', 'user@test.com');
    expect(mock_connector.fetch_attachments).not.toHaveBeenCalled();
    expect(result.manifest.entries[0]!.attachments).toBeUndefined();
  });

  it('deduplicates identical attachments across messages', async () => {
    const same_content = Buffer.from('shared-attachment-bytes');
    const msgs = [make_message('msg-1', 'body-1', true), make_message('msg-2', 'body-2', true)];
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta(msgs));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-x',
        name: 'shared.pdf',
        content_type: 'application/pdf',
        size_bytes: same_content.length,
        is_inline: false,
        content: same_content,
        content_id: '',
      },
    ]);

    vi.mocked(mock_context.storage.exists as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await sync_mailbox('t', 'user@test.com');

    const att_puts = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([key]: [string]) => key.startsWith('attachments/'),
    );
    expect(att_puts).toHaveLength(1);
    expect(result.manifest.entries[0]!.attachments![0]!.storage_key).toBe(
      result.manifest.entries[1]!.attachments![0]!.storage_key,
    );
  });

  it('records attachment metadata with empty key when contentBytes is missing', async () => {
    const msg = make_message('msg-large', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-big',
        name: 'huge-file.zip',
        content_type: 'application/zip',
        size_bytes: 50_000_000,
        is_inline: false,
        content: Buffer.alloc(0),
        content_id: '',
      },
    ]);

    const result = await sync_mailbox('t', 'user@test.com');

    const att = result.manifest.entries[0]!.attachments![0]!;
    expect(att.name).toBe('huge-file.zip');
    expect(att.storage_key).toBe('');
    expect(att.checksum).toBe('');
  });

  it('encrypts attachment content before storing', async () => {
    const msg = make_message('msg-enc', 'body', true);
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_connector.fetch_attachments).mockResolvedValue([
      {
        attachment_id: 'att-enc',
        name: 'secret.doc',
        content_type: 'application/msword',
        size_bytes: 512,
        is_inline: false,
        content: Buffer.from('secret-doc-content'),
        content_id: '',
      },
    ]);

    await sync_mailbox('t', 'user@test.com');

    const att_put = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls.find(
      ([key]: [string]) => key.startsWith('attachments/'),
    );
    expect(att_put).toBeDefined();
    expect(att_put![1][0]).toBe(0x45);
  });
});
