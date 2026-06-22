import { type Container } from 'inversify';
import type { GraphConfig } from '@wisecom/atlas-core/utils/config';
import { GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import { create_graph_client, GRAPH_CLIENT_TOKEN } from '@/graph-client.factory';
import { GraphUserIdentityResolver } from '@/graph-user-identity-resolver.adapter';

export function bind_graph_client(container: Container, config: GraphConfig): void {
  const graph_client = create_graph_client(config);
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph_client);
  container.bind(GRAPH_IDENTITY_RESOLVER_TOKEN).to(GraphUserIdentityResolver).inSingletonScope();
}
