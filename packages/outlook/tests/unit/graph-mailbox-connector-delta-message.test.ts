import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './graph-mailbox-connector.harness';
import { create_mock_client, create_connector } from './graph-mailbox-connector.harness';

describe('GraphMailboxConnector - delta and message APIs', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  describe('fetch_delta', () => {
    it('uses fluent API (.select/.top) for initial full sync', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          {
            id: 'msg-1',
            subject: 'Hello',
            body: { contentType: 'text', content: 'hello body' },
            receivedDateTime: '2025-01-15T10:00:00Z',
            parentFolderId: 'f-inbox',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=abc123',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.message_id).toBe('msg-1');
      expect(result.delta_link).toBe('https://graph.microsoft.com/delta?token=abc123');
      expect(result.delta_reset).toBe(false);
      expect(mock_client._chain.select).toHaveBeenCalled();
      expect(mock_client._chain.top).not.toHaveBeenCalled();
    });

    it('returns full messages directly from delta pages (no per-message fetches)', async () => {
      const graph_message = {
        id: 'msg-full',
        subject: 'Full body test',
        body: { contentType: 'html', content: '<p>Hello</p>' },
        importance: 'normal',
        receivedDateTime: '2025-03-01T12:00:00Z',
        parentFolderId: 'f-inbox',
      };

      mock_client._chain.get.mockResolvedValueOnce({
        value: [graph_message],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=x',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(mock_client._chain.get).toHaveBeenCalledTimes(1);

      const stored = JSON.parse(result.messages[0]!.raw_body.toString('utf-8'));
      expect(stored.body.content).toBe('<p>Hello</p>');
      expect(stored.importance).toBe('normal');
    });

    it('uses prev_delta_link directly for incremental sync', async () => {
      const prev_link = 'https://graph.microsoft.com/delta?token=prev123';

      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          {
            id: 'msg-3',
            subject: 'New',
            receivedDateTime: '2025-02-01T10:00:00Z',
            parentFolderId: 'f-inbox',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=new456',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox', prev_link);

      expect(mock_client.api).toHaveBeenCalledWith(prev_link);
      expect(result.messages).toHaveLength(1);
      expect(result.delta_link).toBe('https://graph.microsoft.com/delta?token=new456');
    });

    it('separates removed items from added items', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        value: [
          { id: 'msg-kept', subject: 'Kept', receivedDateTime: '2025-01-15T10:00:00Z' },
          { id: 'msg-deleted', '@removed': { reason: 'deleted' } },
          { id: 'msg-moved', '@removed': { reason: 'changed' } },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=after',
      });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.message_id).toBe('msg-kept');
      expect(result.removed_ids).toEqual(['msg-deleted', 'msg-moved']);
    });

    it('follows @odata.nextLink across multiple delta pages', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [{ id: 'msg-1', subject: 'Page 1' }],
          '@odata.nextLink': '/delta?skiptoken=page2',
        })
        .mockResolvedValueOnce({
          value: [{ id: 'msg-2', subject: 'Page 2' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=final',
        });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox');

      expect(result.messages).toHaveLength(2);
      expect(result.delta_link).toBe('https://graph.microsoft.com/delta?token=final');
      expect(mock_client._chain.get).toHaveBeenCalledTimes(2);
    });

    it('does not accumulate messages when on_page callback is provided (streaming mode)', async () => {
      mock_client._chain.get
        .mockResolvedValueOnce({
          value: [
            { id: 'msg-1', subject: 'Page 1', receivedDateTime: '2025-01-15T10:00:00Z' },
            { id: 'msg-2', subject: 'Page 1b', receivedDateTime: '2025-01-15T10:01:00Z' },
          ],
          '@odata.nextLink': '/delta?skiptoken=page2',
        })
        .mockResolvedValueOnce({
          value: [{ id: 'msg-3', subject: 'Page 2', receivedDateTime: '2025-01-15T10:02:00Z' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=final',
        });

      const streamed_pages: { page: number; count: number; msgs: string[] }[] = [];
      const on_page = (page_num: number, items_so_far: number, page_msgs: unknown[]): void => {
        streamed_pages.push({
          page: page_num,
          count: items_so_far,
          msgs: page_msgs.map((m) => (m as { message_id: string }).message_id),
        });
      };

      const result = await connector.fetch_delta(
        'tenant-1',
        'user-1',
        'f-inbox',
        undefined,
        on_page,
      );

      expect(result.messages).toHaveLength(0);
      expect(result.delta_link).toBe('https://graph.microsoft.com/delta?token=final');
      expect(streamed_pages).toHaveLength(2);
      expect(streamed_pages[0]).toEqual({ page: 1, count: 2, msgs: ['msg-1', 'msg-2'] });
      expect(streamed_pages[1]).toEqual({ page: 2, count: 3, msgs: ['msg-3'] });
    });

    it('falls back to full enumeration on invalid delta token', async () => {
      const stale_link = 'https://graph.microsoft.com/delta?token=stale';

      mock_client._chain.get
        .mockRejectedValueOnce(new Error('SyncStateNotFound: delta token expired'))
        .mockResolvedValueOnce({
          value: [{ id: 'msg-fresh', subject: 'Fresh sync' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=fresh',
        });

      const result = await connector.fetch_delta('tenant-1', 'user-1', 'f-inbox', stale_link);

      expect(result.delta_reset).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.message_id).toBe('msg-fresh');
    });

    it('rethrows non-delta errors without fallback', async () => {
      mock_client._chain.get.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(connector.fetch_delta('tenant-1', 'user-1', 'f-inbox')).rejects.toThrow(
        'Network timeout',
      );
    });
  });

  describe('fetch_message', () => {
    it('fetches a single message and returns MailMessage shape', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        id: 'msg-single',
        subject: 'Single fetch',
        receivedDateTime: '2025-04-01T08:00:00Z',
        parentFolderId: 'f-sent',
        body: { content: 'single body' },
      });

      const result = await connector.fetch_message('tenant-1', 'user-1', 'msg-single');

      expect(result.message_id).toBe('msg-single');
      expect(result.subject).toBe('Single fetch');
      expect(result.folder_id).toBe('f-sent');
      expect(result.received_at).toEqual(new Date('2025-04-01T08:00:00Z'));
      expect(result.raw_body).toBeInstanceOf(Buffer);
      expect(result.size_bytes).toBeGreaterThan(0);
    });

    it('populates has_attachments from Graph response', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        id: 'msg-att',
        subject: 'With attachments',
        receivedDateTime: '2025-04-01T08:00:00Z',
        hasAttachments: true,
      });

      const result = await connector.fetch_message('tenant-1', 'user-1', 'msg-att');
      expect(result.has_attachments).toBe(true);
    });

    it('defaults has_attachments to false when not set', async () => {
      mock_client._chain.get.mockResolvedValueOnce({
        id: 'msg-no-att',
        subject: 'No attachments',
        receivedDateTime: '2025-04-01T08:00:00Z',
      });

      const result = await connector.fetch_message('tenant-1', 'user-1', 'msg-no-att');
      expect(result.has_attachments).toBe(false);
    });
  });
});
