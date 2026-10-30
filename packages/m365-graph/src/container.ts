import { type Container } from 'inversify';
import type { GraphConfig } from '@wisecom/atlas-core/utils/config';
import { GRAPH_IDENTITY_RESOLVER_TOKEN } from '@wisecom/atlas-core';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { THROTTLE_COORDINATOR_TOKEN } from '@wisecom/atlas-types';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import {
  create_graph_auth_provider,
  create_graph_client,
  GRAPH_AUTH_PROVIDER_TOKEN,
  GRAPH_CLIENT_TOKEN,
} from '@/graph-client.factory';
import { GraphUserIdentityResolver } from '@/graph-user-identity-resolver.adapter';
import { scope_connector_throttling } from '@/throttle-scoped-connector';

/**
 * Binds a Graph client, its shared authentication provider, and the throttle coordinator every
 * Graph connector reports to, without acquiring a token. `throttle` replaces the in-memory default.
 */
export function bind_graph_client(
  container: Container,
  config: GraphConfig,
  host_throttle?: ThrottleCoordinator,
): void {
  const throttle = host_throttle ?? new InProcessThrottleCoordinator();
  const auth_provider = create_graph_auth_provider(config);
  const graph_client = create_graph_client(auth_provider);
  container.bind(GRAPH_AUTH_PROVIDER_TOKEN).toConstantValue(auth_provider);
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph_client);
  const throttle_binding = container
    .bind<ThrottleCoordinator>(THROTTLE_COORDINATOR_TOKEN)
    .toConstantValue(throttle);
  // A raised cooldown holds a live timer, deliberately not unref'd, so a disposed instance would
  // otherwise keep the process alive until it expires. A host-supplied coordinator is shared
  // beyond this instance and is the host's to clear.
  if (throttle instanceof InProcessThrottleCoordinator) {
    throttle_binding.onDeactivation(() => throttle.clear());
  }
  container.bind(GraphUserIdentityResolver).toSelf().inSingletonScope();
  container
    .bind(GRAPH_IDENTITY_RESOLVER_TOKEN)
    .toDynamicValue((ctx) =>
      scope_connector_throttling(ctx.get(GraphUserIdentityResolver), throttle, 'identity'),
    )
    .inSingletonScope();
}
