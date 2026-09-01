import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { Container } from 'inversify';
import { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import { GRAPH_CLIENT_TOKEN } from '@wisecom/atlas-m365-graph';

interface MockChain {
  select: Mock;
  top: Mock;
  header: Mock;
  responseType: Mock;
  get: Mock;
}

interface MockClient {
  api: Mock;
  _chain: MockChain;
}

function create_mock_client(): MockClient {
  const get_fn = vi.fn();
  const chain: MockChain = {
    select: vi.fn(),
    top: vi.fn(),
    header: vi.fn(),
    responseType: vi.fn(),
    get: get_fn,
  };
  chain.select.mockReturnValue(chain);
  chain.top.mockReturnValue(chain);
  chain.header.mockReturnValue(chain);
  chain.responseType.mockReturnValue(chain);
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

  it('keeps all three attachment types, not only fileAttachment (issue #49)', async () => {
    const raw_bytes = Buffer.from('hello pdf');
    const attached_mail = Buffer.from('From: a@b.com\r\nSubject: FW: escalation\r\n\r\nbody');

    mock_client._chain.get
      .mockResolvedValueOnce({
        value: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'att-1',
            name: 'report.pdf',
            contentType: 'application/pdf',
            size: 1024,
            isInline: false,
            contentBytes: raw_bytes.toString('base64'),
          },
          {
            '@odata.type': '#microsoft.graph.referenceAttachment',
            id: 'att-ref',
            name: 'link.docx',
            sourceUrl: 'https://contoso.sharepoint.com/sites/x/link.docx',
          },
          { '@odata.type': '#microsoft.graph.itemAttachment', id: 'att-item', name: 'embedded' },
        ],
      })
      // Only the item attachment needs a /$value fetch: the file attachment
      // arrived inline, and a reference attachment has no bytes to fetch.
      .mockResolvedValueOnce(
        attached_mail.buffer.slice(
          attached_mail.byteOffset,
          attached_mail.byteOffset + attached_mail.byteLength,
        ),
      );

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');

    expect(result).toHaveLength(3);

    const file = result.find((a) => a.attachment_id === 'att-1')!;
    expect(file.name).toBe('report.pdf');
    expect(file.content).toEqual(raw_bytes);
    expect(file.is_inline).toBe(false);

    const item = result.find((a) => a.attachment_id === 'att-item')!;
    expect(item.content_type).toBe('message/rfc822');
    expect(item.name).toBe('embedded.eml');
    expect(item.content).toEqual(attached_mail);

    const reference = result.find((a) => a.attachment_id === 'att-ref')!;
    expect(reference.content_type).toBe('text/uri-list');
    expect(reference.content.toString('utf-8')).toContain(
      'https://contoso.sharepoint.com/sites/x/link.docx',
    );
  });

  it('downloads content via /$value for attachments without contentBytes', async () => {
    const raw_bytes = Buffer.from('binary-payload-of-a-large-zip');
    mock_client._chain.get
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce(
        raw_bytes.buffer.slice(raw_bytes.byteOffset, raw_bytes.byteOffset + raw_bytes.byteLength),
      );

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('huge.zip');
    expect(result[0]!.content).toEqual(raw_bytes);
    expect(mock_client.api).toHaveBeenCalledWith(
      '/users/user-1/messages/msg-1/attachments/att-big/$value',
    );
  });

  it('does not call /$value for zero-size attachments without contentBytes', async () => {
    mock_client._chain.get.mockResolvedValueOnce({
      value: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: 'att-empty',
          name: 'empty.txt',
          contentType: 'text/plain',
          size: 0,
          isInline: false,
        },
      ],
    });

    const result = await connector.fetch_attachments('tenant-1', 'user-1', 'msg-1');

    expect(result).toHaveLength(1);
    expect(result[0]!.content.length).toBe(0);
    expect(mock_client.api).toHaveBeenCalledTimes(1);
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
