import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { UserIdentityResolver, ResolvedUserIdentity } from '@atlas/types';
import { GRAPH_CLIENT_TOKEN } from '@/graph-client.factory';

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

  /** Batch resolves multiple emails using individual Graph calls with concurrency limit. */
  async resolve_users(tenant_id: string, emails: string[]): Promise<ResolvedUserIdentity[]> {
    const CONCURRENCY = 5;
    const results: ResolvedUserIdentity[] = [];
    const queue = [...emails];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const next_email = queue.shift()!;
        results.push(await this.resolve_user(tenant_id, next_email));
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, emails.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /** Graph-only resolver cannot do reverse lookups without an object ID query. Returns undefined. */
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
    } catch {
      return undefined;
    }
  }
}
