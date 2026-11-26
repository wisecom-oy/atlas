import { inject, injectable } from 'inversify';
import type { Client } from '@microsoft/microsoft-graph-client';
import type { UserIdentityResolver, ResolvedUserIdentity } from '@wisecom/atlas-types';
import { GRAPH_CLIENT_TOKEN } from '@/graph-client.factory';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { describe_graph_error, with_graph_retry } from '@/graph-request-error-handler';
import { parse_user_page } from '@/graph-user-page';
import { graph_status_of, read_confirming_not_found } from '@/graph-not-found-confirmation';

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
   *
   * The lookup is the first read of the command that asked for it, so a `404` is read again under
   * the first-read confirmation rule before it is believed: Graph answers `404` for a user that
   * exists while a directory replica lags, and one answer used to end a first backup with exit `7`.
   * Any other answer is passed on from its first read, as before.
   */
  async resolve_user(tenant_id: string, email: string): Promise<ResolvedUserIdentity> {
    void tenant_id;
    const normalized_email = email.toLowerCase().trim();
    const response = await read_confirming_not_found(
      () => this.find_user(normalized_email),
      (err) => graph_status_of(err) !== 404,
    );

    return {
      object_id: response.id,
      display_name: response.displayName ?? normalized_email,
      email: response.mail ?? response.userPrincipalName ?? normalized_email,
    };
  }

  /** Reads the user by UPN, then by primary SMTP address after a `404`. */
  private async find_user(normalized_email: string): Promise<GraphUserRecord> {
    return this.get_user_by_upn(normalized_email).catch(async (err: unknown) => {
      if ((err as Record<string, unknown>).statusCode !== 404) throw err;
      const by_mail = await this.find_user_by_mail(normalized_email);
      if (!by_mail) throw err;
      return by_mail;
    });
  }

  // Every lookup goes through with_graph_retry: it is the one layer that retries a 429 or 5xx and
  // reports each 429 to the ambient throttle coordinator. These calls used to bypass it, so a
  // throttled lookup failed the whole operation and no other request ever heard about it (#551).
  // A 404 or 403 is not retryable and comes back unchanged, so the callers' branching still holds.
  // Each attempt passes its signal, so a Ctrl+C or a bounded lookup closes the request it ends.

  private async get_user_by_upn(upn: string): Promise<GraphUserRecord> {
    const raw: unknown = await with_graph_retry((signal) =>
      this._client
        .api(`/users/${encodeURIComponent(upn)}`)
        .option('signal', signal)
        .select(USER_FIELDS)
        .get(),
    );
    return parse_user_record(raw);
  }

  private async find_user_by_mail(mail: string): Promise<GraphUserRecord | undefined> {
    const raw: unknown = await with_graph_retry((signal) =>
      this._client
        .api('/users')
        .option('signal', signal)
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
      // An exhausted 429 arrives as ThrottledError and any other exhausted failure as
      // GraphUnavailableError, neither with a top-level status, so only a genuine 404 reaches the
      // undefined below.
      if ((err as Record<string, unknown>).statusCode !== 404) throw err;

      logger.debug(`Graph has no user for object ID ${object_id}: ${describe_graph_error(err)}`);
      return undefined;
    }
  }
}
