import { ClientSecretCredential } from '@azure/identity';
import {
  AuthenticationHandler,
  Client,
  HTTPMessageHandler,
  RedirectHandler,
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
 * observes every request actually sent, including each redirect the
 * RedirectHandler follows, since it re-executes the chain below it. It is
 * otherwise the SDK's default chain in the SDK's order, minus its RetryHandler:
 * `with_graph_retry` owns retry policy for every call.
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
 * The SDK's default handlers with cost accounting spliced in, and the SDK's own
 * retry disabled.
 *
 * `with_graph_retry` wraps every Graph call this client serves and is strictly
 * more capable: it honours Retry-After, adds jitter, retries network faults the
 * SDK handler ignores, and raises the global throttle fence. Leaving the SDK
 * handler retrying as well multiplied the two budgets, so one logical call could
 * reach ~52 HTTP attempts, every one of them counted against the throttling
 * limits the backoff exists to respect. Retry lives in exactly one layer now,
 * bounding a call at MAX_RETRIES + 1 attempts.
 *
 * Position still matters. The cost middleware sits below RedirectHandler, which
 * re-executes everything beneath it, so it sees each followed redirect rather
 * than one logical call. It sits above TelemetryHandler because the SDK requires
 * telemetry to be the handler immediately before the transport, so its usage
 * flags cover the real request.
 */
function build_middleware_chain(auth_provider: TokenCredentialAuthenticationProvider): Middleware {
  const chain: Middleware[] = [
    new AuthenticationHandler(auth_provider),
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
