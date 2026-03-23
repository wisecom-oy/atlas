import { vi } from 'vitest';
import { Container } from 'inversify';
import { GraphMailboxConnector } from '@/adapters/m365/graph-mailbox-connector.adapter';
import { GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';

interface MockChain {
  select: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

export interface MockClient {
  api: ReturnType<typeof vi.fn>;
  _chain: MockChain;
}

export function create_mock_client(): MockClient {
  const get_fn = vi.fn();
  const chain: MockChain = {
    select: vi.fn(),
    top: vi.fn(),
    header: vi.fn(),
    get: get_fn,
  };
  chain.select.mockReturnValue(chain);
  chain.top.mockReturnValue(chain);
  chain.header.mockReturnValue(chain);

  const api_fn = vi.fn().mockReturnValue(chain);
  return { api: api_fn, _chain: chain };
}

export function create_connector(mock_client: MockClient): GraphMailboxConnector {
  const container = new Container();
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(mock_client);
  container.bind(GraphMailboxConnector).toSelf();
  return container.get(GraphMailboxConnector);
}
