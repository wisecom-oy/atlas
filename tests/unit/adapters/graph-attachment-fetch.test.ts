import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import { GraphMailboxConnector } from '@/adapters/m365/graph-mailbox-connector.adapter';
import { GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';

interface MockChain {
  select: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

interface MockClient {
  api: ReturnType<typeof vi.fn>;
  _chain: MockChain;
}

function create_mock_client(): MockClient {
  const get_fn = vi.fn();
  const chain: MockChain = { select: vi.fn(), top: vi.fn(), header: vi.fn(), get: get_fn };
  chain.select.mockReturnValue(chain);
  chain.top.mockReturnValue(chain);
  chain.header.mockReturnValue(chain);
  const api_fn = vi.fn().mockReturnValue(chain);
  return { api: api_fn, _chain: chain };
}

function create_connector(mock_client: MockClient): GraphMailboxConnector {
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(mock_client);
  container.bind(GraphMailboxConnector).toSelf();
  return container.get(GraphMailboxConnector);
}

describe('GraphMailboxConnector – fetch_attachments', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  it('returns only fileAttachment types with decoded content', async () => {
    const raw_bytes = Buffer.from('hello pdf');
    const base64_content = raw_bytes.toString('base64');

    mock_client._chain.get.mockResolvedValueOnce({
      value: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'att-1',
          name: 'report.pdf',
          contentType: 'application/pdf',
          size: 1024,
          isInline: false,
          contentBytes: base64_content,
        },
        { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'att-ref', name: 'link.docx' },
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'att-item', name: 'embedded' },
      ],
    });

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');

    expect(result).toHaveLength(1);
    expect(result[0]!.attachment_id).toBe('att-1');
    expect(result[0]!.name).toBe('report.pdf');
    expect(result[0]!.content).toEqual(raw_bytes);
    expect(result[0]!.is_inline).toBe(false);
  });

  it('returns empty buffer for attachments without contentBytes (>4MB)', async () => {
    mock_client._chain.get.mockResolvedValueOnce({
      value: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'att-big',
          name: 'huge.zip',
          contentType: 'application/zip',
          size: 50_000_000,
          isInline: false,
        },
      ],
    });

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('huge.zip');
    expect(result[0]!.content.length).toBe(0);
  });

  it('handles inline attachments with isInline flag', async () => {
    mock_client._chain.get.mockResolvedValueOnce({
      value: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'att-inline',
          name: 'logo.png',
          contentType: 'image/png',
          size: 256,
          isInline: true,
          contentBytes: Buffer.from('png-data').toString('base64'),
        },
      ],
    });

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');
    expect(result[0]!.is_inline).toBe(true);
  });

  it('maps contentId from Graph to content_id on MessageAttachment', async () => {
    mock_client._chain.get.mockResolvedValueOnce({
      value: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'att-cid',
          name: 'banner.png',
          contentType: 'image/png',
          size: 512,
          isInline: true,
          contentBytes: Buffer.from('png-bytes').toString('base64'),
          contentId: 'image001.png@01DA3B2F.5A7E8990',
        },
      ],
    });

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');
    expect(result[0]!.content_id).toBe('image001.png@01DA3B2F.5A7E8990');
  });

  it('defaults content_id to empty string when Graph omits contentId', async () => {
    mock_client._chain.get.mockResolvedValueOnce({
      value: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'att-no-cid',
          name: 'report.pdf',
          contentType: 'application/pdf',
          size: 1024,
          isInline: false,
          contentBytes: Buffer.from('pdf').toString('base64'),
        },
      ],
    });

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');
    expect(result[0]!.content_id).toBe('');
  });

  it('returns empty array when no attachments exist', async () => {
    mock_client._chain.get.mockResolvedValueOnce({ value: [] });
    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');
    expect(result).toEqual([]);
  });

  it('paginates through attachment pages', async () => {
    mock_client._chain.get
      .mockResolvedValueOnce({
        value: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'att-1',
            name: 'a.pdf',
            contentType: 'application/pdf',
            size: 100,
            isInline: false,
            contentBytes: Buffer.from('a').toString('base64'),
          },
        ],
        '@odata.nextLink': '/next-attachments',
      })
      .mockResolvedValueOnce({
        value: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'att-2',
            name: 'b.pdf',
            contentType: 'application/pdf',
            size: 200,
            isInline: false,
            contentBytes: Buffer.from('b').toString('base64'),
          },
        ],
      });

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');

    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('a.pdf');
    expect(result[1]!.name).toBe('b.pdf');
  });

  it('calls the correct Graph API endpoint', async () => {
    mock_client._chain.get.mockResolvedValueOnce({ value: [] });

    await connector.fetch_attachments('tenant-1', 'alice@test.com', 'msg-42');

    expect(mock_client.api).toHaveBeenCalledWith(
      '/users/alice@test.com/messages/msg-42/attachments',
    );
  });
});
