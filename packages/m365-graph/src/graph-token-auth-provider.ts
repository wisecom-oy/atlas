import type {
  AuthenticationProvider,
  AuthenticationProviderOptions,
} from '@microsoft/microsoft-graph-client';
import { to_token_request_error } from '@/graph-token-failure';

/**
 * Wraps the credential's authentication provider so a failed token request reaches Atlas as a
 * `GraphTokenRequestError`, which says whether Entra ID refused the credentials, instead of the
 * Graph SDK's untyped `statusCode: -1` error (issue #786).
 */
export class TypedTokenAuthProvider implements AuthenticationProvider {
  constructor(private readonly credential_provider: AuthenticationProvider) {}

  /** Returns a Graph access token, or throws `GraphTokenRequestError` saying why none came. */
  async getAccessToken(options?: AuthenticationProviderOptions): Promise<string> {
    try {
      return await this.credential_provider.getAccessToken(options);
    } catch (err) {
      throw to_token_request_error(err);
    }
  }
}
