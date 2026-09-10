import { type Container } from 'inversify';
import type { GraphConfig } from '@wisecom/atlas-core/utils/config';
import { GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import {
  create_graph_auth_provider,
  create_graph_client,
  GRAPH_AUTH_PROVIDER_TOKEN,
  GRAPH_CLIENT_TOKEN,
} from '@/graph-client.factory';
import { GraphUserIdentityResolver } from '@/graph-user-identity-resolver.adapter';

/** Binds a Graph client and its shared authentication provider without acquiring a token. */
export function bind_graph_client(container: Container, config: GraphConfig): void {
  const auth_provider = create_graph_auth_provider(config);
  const graph_client = create_graph_client(auth_provider);
  container.bind(GRAPH_AUTH_PROVIDER_TOKEN).toConstantValue(auth_provider);
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph_client);
  container.bind(GRAPH_IDENTITY_RESOLVER_TOKEN).to(GraphUserIdentityResolver).inSingletonScope();
}
