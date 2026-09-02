import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { GraphMailboxConnector } from '@/adapters/graph-mailbox-connector.adapter';
import type { MockClient } from './mailbox-connector.fixtures';
import { create_mock_client, create_connector } from './mailbox-connector.fixtures';

// Issue #48: every Graph request that produces or consumes a message/folder ID
// must carry Prefer: IdType="ImmutableId". Mixing ID formats corrupts
// correlation between manifests, delta links, and live objects.

const IMMUTABLE_ID = 'IdType="ImmutableId"';

function prefer_headers_sent(mock_client: MockClient): string[] {
  return mock_client._chain.header.mock.calls
    .filter((c) => c[0] === 'Prefer')
    .map((c) => c[1] as string);
}

describe('GraphMailboxConnector - immutable message IDs (issue #48)', () => {
  let mock_client: MockClient;
  let connector: GraphMailboxConnector;

  beforeEach(() => {
    mock_client = create_mock_client();
    connector = create_connector(mock_client);
  });

  it('sends IdType=ImmutableId on the initial delta page', async () => {
    mock_client._chain.get.mockResolvedValueOnce({ value: [] });

    await connector.fetch_delta('t', 'owner-1', 'folder-1');

    const headers = prefer_headers_sent(mock_client);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain(IMMUTABLE_ID);
    expect(headers[0]).toContain('odata.maxpagesize=');
  });

  it('sends IdType=ImmutableId on continuation pages from a saved delta link', async () => {
    mock_client._chain.get.mockResolvedValueOnce({ value: [] });

    await connector.fetch_delta('t', 'owner-1', 'folder-1', 'https://saved-delta-link');

    const headers = prefer_headers_sent(mock_client);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain(IMMUTABLE_ID);
  });

  it('sends IdType=ImmutableId when fetching a single message by ID', async () => {
    mock_client._chain.get.mockResolvedValueOnce({ id: 'msg-1' });

    await connector.fetch_message('t', 'owner-1', 'msg-1');

    const headers = prefer_headers_sent(mock_client);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain(IMMUTABLE_ID);
  });

  it('sends IdType=ImmutableId when listing attachments for a message', async () => {
    mock_client._chain.get.mockResolvedValueOnce({ value: [] });

    await connector.fetch_attachments('t', 'owner-1', 'msg-1');

    const headers = prefer_headers_sent(mock_client);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain(IMMUTABLE_ID);
  });
});
