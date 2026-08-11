import { ClientSecretCredential } from '@azure/identity';
import {
  AuthenticationHandler,
  Client,
  HTTPMessageHandler,
  RedirectHandler,
  RetryHandler,
  RetryHandlerOptions,
  RedirectHandlerOptions,
  TelemetryHandler,
  type Middleware,
} from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { GraphCostMiddleware } from '@/graph-cost-middleware';
import type { GraphConfig } from '@wisecom/atlas-core/utils/config';

export const GRAPH_CLIENT_TOKEN = Symbol.for('GraphClient');

const GRAPH_BASE_URL = 'https://graph.microsoft.com';

/**
 * Creates an authenticated Microsoft Graph client using the OAuth2
 * client credentials flow. The SDK handles token acquisition, caching,
 * and automatic refresh.
 *
 * The middleware chain is spelled out rather than derived from `authProvider`
 * so a cost middleware can sit immediately before the HTTP handler, where it
 * observes every request actually sent -- including each retry the RetryHandler
 * makes and each redirect the RedirectHandler follows, since both re-execute
 * the chain below them. It is otherwise the SDK's own default chain, in the
 * SDK's own order.
 *
 * Hardcodes the base URL to https://graph.microsoft.com to prevent
 * any downstream override to a non-TLS endpoint. Refuses to start
 * if NODE_TLS_REJECT_UNAUTHORIZED=0 would disable certificate validation.
 */
export function create_graph_client(config: GraphConfig): Client {
  assert_tls_not_disabled();
  const credential = build_credential(config);
  const auth_provider = build_auth_provider(credential);
  return Client.initWithMiddleware({
    middleware: build_middleware_chain(auth_provider),
    baseUrl: GRAPH_BASE_URL,
  });
}

/**
 * The SDK's default handlers with cost accounting spliced in.
 *
 * Position matters twice over. The cost middleware sits below RetryHandler and
 * RedirectHandler, both of which re-execute everything beneath them, so it sees
 * each attempt and each followed redirect rather than one logical call. It sits
 * above TelemetryHandler because the SDK requires telemetry to be the handler
 * immediately before the transport, so its usage flags cover the real request.
 */
function build_middleware_chain(auth_provider: TokenCredentialAuthenticationProvider): Middleware {
  const chain: Middleware[] = [
    new AuthenticationHandler(auth_provider),
    new RetryHandler(new RetryHandlerOptions()),
    new RedirectHandler(new RedirectHandlerOptions()),
    new GraphCostMiddleware(),
    new TelemetryHandler(),
    new HTTPMessageHandler(),
  ];

  for (let i = 0; i < chain.length - 1; i++) {
    chain[i]!.setNext?.(chain[i + 1]!);
  }
  return chain[0]!;
}

/** Fails hard if TLS cert validation has been globally disabled. */
function assert_tls_not_disabled(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 detected — refusing to connect to Microsoft Graph ' +
        'with TLS certificate validation disabled. Remove this env var to proceed safely.',
    );
  }
}

/** Builds an Azure AD client-secret credential for the given tenant. */
function build_credential(config: GraphConfig): ClientSecretCredential {
  return new ClientSecretCredential(config.tenant_id, config.client_id, config.client_secret);
}

/** Wraps the credential in a Graph-compatible authentication provider. */
function build_auth_provider(
  credential: ClientSecretCredential,
): TokenCredentialAuthenticationProvider {
  return new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
}
