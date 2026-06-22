import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import type { GraphConfig } from '@atlas/core/utils/config';

export const GRAPH_CLIENT_TOKEN = Symbol.for('GraphClient');

const GRAPH_BASE_URL = 'https://graph.microsoft.com';

/**
 * Creates an authenticated Microsoft Graph client using the OAuth2
 * client credentials flow. The SDK handles token acquisition, caching,
 * and automatic refresh. Built-in middleware provides retry on 429/5xx
 * and redirect following.
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
    authProvider: auth_provider,
    baseUrl: GRAPH_BASE_URL,
  });
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
