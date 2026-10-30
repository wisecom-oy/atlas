import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { UserIdentityResolver, ResolvedUserIdentity } from '@wisecom/atlas-types';
import { GRAPH_CLIENT_TOKEN } from '@/graph-client.factory';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { describe_graph_error, with_graph_retry } from '@/graph-request-error-handler';
import { parse_user_page } from '@/graph-user-page';

const USER_FIELDS = 'id,displayName,mail,userPrincipalName';

interface GraphUserRecord {
  id: string;
  displayName?: string | undefined;
  mail?: string | undefined;
  userPrincipalName?: string | undefined;
}

/** Reads a string field from an untyped Graph payload; undefined when absent or not a string. */
function optional_string(raw: object, key: string): string | undefined {
  const value: unknown = Reflect.get(raw, key);
  return typeof value === 'string' ? value : undefined;
}

/** Narrows an untyped Graph user payload. A payload without a string id is a contract break. */
function parse_user_record(raw: unknown): GraphUserRecord {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('id' in raw) ||
    typeof raw.id !== 'string' ||
    raw.id === ''
  ) {
    throw new Error('Graph user response has no id');
  }
  return {
    id: raw.id,
    displayName: optional_string(raw, 'displayName'),
    mail: optional_string(raw, 'mail'),
    userPrincipalName: optional_string(raw, 'userPrincipalName'),
  };
}

/** Resolves Azure AD / Entra user identities via Microsoft Graph. */
@injectable()
export class GraphUserIdentityResolver implements UserIdentityResolver {
  constructor(@inject(GRAPH_CLIENT_TOKEN) private readonly _client: Client) {}

  /**
   * Resolves an email to the Entra ID object. `/users/{key}` accepts a UPN, and a mailbox's
   * primary SMTP address can differ from it, so a 404 there retries as a `mail` filter before
   * reporting the user missing.
   */
  async resolve_user(tenant_id: string, email: string): Promise<ResolvedUserIdentity> {
    void tenant_id;
    const normalized_email = email.toLowerCase().trim();
    const response = await this.get_user_by_upn(normalized_email).catch(async (err: unknown) => {
      if ((err as Record<string, unknown>).statusCode !== 404) throw err;
      const by_mail = await this.find_user_by_mail(normalized_email);
      if (!by_mail) throw err;
      return by_mail;
    });

    return {
      object_id: response.id,
      display_name: response.displayName ?? normalized_email,
      email: response.mail ?? response.userPrincipalName ?? normalized_email,
    };
  }

  // Every lookup goes through with_graph_retry: it is the one layer that retries a 429 or 5xx and
  // reports each 429 to the ambient throttle coordinator. These calls used to bypass it, so a
  // throttled lookup failed the whole operation and no other request ever heard about it (#551).
  // A 404 or 403 is not retryable and comes back unchanged, so the callers' branching still holds.

  private async get_user_by_upn(upn: string): Promise<GraphUserRecord> {
    const raw: unknown = await with_graph_retry(() =>
      this._client
        .api(`/users/${encodeURIComponent(upn)}`)
        .select(USER_FIELDS)
        .get(),
    );
    return parse_user_record(raw);
  }

  private async find_user_by_mail(mail: string): Promise<GraphUserRecord | undefined> {
    const raw: unknown = await with_graph_retry(() =>
      this._client
        .api('/users')
        .filter(`mail eq '${mail.replaceAll("'", "''")}'`)
        .select(USER_FIELDS)
        .get(),
    );
    return parse_user_page(raw).users.map(parse_user_record)[0];
  }

  /**
   * Reverse lookup of an Entra object ID, or undefined when Graph says there is no such user.
   *
   * Only a 404 means "no such object". A 5xx or a dropped socket means Graph could not answer, and
   * collapsing that into the same undefined told callers a user does not exist because the service
   * was briefly unavailable (issue #202). Those are retried, then rethrown if the budget runs out.
   * Anything else rethrows too: a 403 is a missing `User.Read.All` grant, which would otherwise
   * degrade every identity lookup in the tenant to a silent nothing that looks exactly like a typo.
   */
  async resolve_by_object_id(
    _tenant_id: string,
    object_id: string,
  ): Promise<ResolvedUserIdentity | undefined> {
    try {
      const raw: unknown = await with_graph_retry(() =>
        this._client
          .api(`/users/${encodeURIComponent(object_id)}`)
          .select('id,displayName,mail,userPrincipalName')
          .get(),
      );
      const response = parse_user_record(raw);
      return {
        object_id: response.id,
        display_name: response.displayName ?? object_id,
        email: response.mail ?? response.userPrincipalName ?? '',
      };
    } catch (err) {
      // An exhausted 429 arrives as ThrottledError, and other exhausted failures keep their status,
      // so only a genuine 404 reaches the undefined below.
      if ((err as Record<string, unknown>).statusCode !== 404) throw err;

      logger.debug(`Graph has no user for object ID ${object_id}: ${describe_graph_error(err)}`);
      return undefined;
    }
  }
}
