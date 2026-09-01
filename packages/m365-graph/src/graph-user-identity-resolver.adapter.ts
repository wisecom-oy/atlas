import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { UserIdentityResolver, ResolvedUserIdentity } from '@wisecom/atlas-types';
import { GRAPH_CLIENT_TOKEN } from '@/graph-client.factory';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { describe_graph_error, is_retryable_error } from '@/graph-request-error-handler';

/** Resolves Azure AD / Entra user identities via Microsoft Graph. */
@injectable()
export class GraphUserIdentityResolver implements UserIdentityResolver {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /** Resolves a single email/UPN to the Entra ID object by querying Graph /users/{email}. */
  async resolve_user(tenant_id: string, email: string): Promise<ResolvedUserIdentity> {
    void tenant_id;
    const normalized_email = email.toLowerCase().trim();
    const response = await this._client
      .api(`/users/${encodeURIComponent(normalized_email)}`)
      .select('id,displayName,mail,userPrincipalName')
      .get();

    return {
      object_id: response.id,
      display_name: response.displayName ?? normalized_email,
      email: response.mail ?? response.userPrincipalName ?? normalized_email,
    };
  }

  /**
   * Reverse lookup of an Entra object ID, or undefined when Graph says there is no such user.
   *
   * Only a 404 means "no such object". A 5xx or a dropped socket means Graph could not answer, and
   * collapsing that into the same undefined told callers a user does not exist because the service
   * was briefly unavailable (issue #202). Those rethrow so the caller can retry or report. Anything
   * else rethrows too: a 403 is a missing `User.Read.All` grant, which would otherwise degrade
   * every identity lookup in the tenant to a silent nothing that looks exactly like a typo.
   */
  async resolve_by_object_id(
    _tenant_id: string,
    object_id: string,
  ): Promise<ResolvedUserIdentity | undefined> {
    try {
      const response = await this._client
        .api(`/users/${encodeURIComponent(object_id)}`)
        .select('id,displayName,mail,userPrincipalName')
        .get();
      return {
        object_id: response.id,
        display_name: response.displayName ?? object_id,
        email: response.mail ?? response.userPrincipalName ?? '',
      };
    } catch (err) {
      if (is_retryable_error(err)) throw err;
      if ((err as Record<string, unknown>).statusCode !== 404) throw err;

      logger.debug(`Graph has no user for object ID ${object_id}: ${describe_graph_error(err)}`);
      return undefined;
    }
  }
}
