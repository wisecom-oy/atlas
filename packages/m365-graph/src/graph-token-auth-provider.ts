import type {
  AuthenticationProvider,
  AuthenticationProviderOptions,
} from '@microsoft/microsoft-graph-client';
import { get_active_graph_attempt } from '@/graph-attempt';
import { to_token_request_error } from '@/graph-token-failure';
import { SharedTokenRequest } from '@/graph-token-wait';

/**
 * Wraps the credential's authentication provider so a failed token request reaches Atlas as a
 * `GraphTokenRequestError`, which says whether Entra ID refused the credentials, instead of the
 * Graph SDK's untyped `statusCode: -1` error (issue #786).
 *
 * It also lets a Graph `401` discard the token Graph rejected (issue #861). MSAL renews a cached
 * token only near its expiry and offers no way to drop it, so discarding builds a new credential,
 * whose empty cache makes the next request fetch a newly issued token.
 *
 * Requests that need a token at the same time share one token request (issue #889). Each waits
 * under its own attempt's signals, so a timed-out or cancelled attempt stops waiting and sends
 * nothing, and a token request nobody waits for is aborted.
 */
export class TypedTokenAuthProvider implements AuthenticationProvider {
  private credential_provider: AuthenticationProvider;
  /** Counts discards, so a token fetched by a discarded credential is not recorded as current. */
  private generation = 0;
  /** The token the current credential last handed out, or undefined since the last discard. */
  private current_token: string | undefined;
  /** The token request the current credential has in progress, shared by every caller. */
  private in_progress: SharedTokenRequest | undefined;

  constructor(private readonly create_credential_provider: () => AuthenticationProvider) {
    this.credential_provider = create_credential_provider();
  }

  /** Returns a Graph access token, or throws `GraphTokenRequestError` saying why none came. */
  async getAccessToken(options?: AuthenticationProviderOptions): Promise<string> {
    return await this.join_token_request(options).wait(get_active_graph_attempt());
  }

  /** The token request in progress for the current credential, or a new one when none is. */
  private join_token_request(
    options: AuthenticationProviderOptions | undefined,
  ): SharedTokenRequest {
    if (this.in_progress?.is_joinable() === true) return this.in_progress;
    const generation = this.generation;
    const credential_provider = this.credential_provider;
    this.in_progress = new SharedTokenRequest(async () => {
      let token: string;
      try {
        token = await credential_provider.getAccessToken(options);
      } catch (err) {
        throw to_token_request_error(err);
      }
      if (generation === this.generation) this.current_token = token;
      return token;
    });
    return this.in_progress;
  }

  /**
   * Replaces the credential when Graph rejected the token it is handing out, so the next request
   * gets a newly issued one. A token already replaced is ignored: requests that failed together
   * cost one new token, not one each. An unknown token (undefined) always replaces the credential.
   */
  discard_rejected_token(rejected_token: string | undefined): void {
    if (rejected_token !== undefined && rejected_token !== this.current_token) return;
    this.credential_provider = this.create_credential_provider();
    this.generation++;
    this.current_token = undefined;
    this.in_progress = undefined;
  }
}
