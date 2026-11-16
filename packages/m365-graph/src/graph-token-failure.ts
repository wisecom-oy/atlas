import { GraphClientError } from '@microsoft/microsoft-graph-client';
import { AtlasError, AuthError, GraphUnavailableError } from '@wisecom/atlas-types';
import { is_network_error } from '@/graph-network-error';
import type { ExhaustedAttempts } from '@/graph-unavailable-failure';

/** Entra ID statuses that report its own trouble rather than a refusal of the credentials. */
const TRANSIENT_ENTRA_STATUSES = new Set([408, 429]);

/** MSAL's code for a token request that got no response; it drops the socket error itself. */
const MSAL_NETWORK_ERROR_CODE = 'network_error';

/**
 * A Graph token request that failed, carried through the Graph SDK intact (issue #786).
 *
 * `GraphRequest` turns any other error the authentication middleware throws into a `GraphError`
 * with `statusCode: -1`, the credential error's class name as `code`, and no `cause`. A wrong client
 * secret, an Entra ID outage and an unreachable network then looked alike and exited 1.
 * `GraphClientError` is the one type it rethrows unchanged.
 *
 * `cause` is an `AuthError` when Entra ID refused the credentials, otherwise the credential's own
 * error. The carrier has no `statusCode`, so no Graph status check reads Entra's status as Graph's.
 */
export class GraphTokenRequestError extends GraphClientError {
  /** HTTP status Entra ID answered with, or undefined when the request got no response. */
  readonly entra_status: number | undefined;
  /** True when repeating the request can succeed: no response, a 408, a 429 or a 5xx. */
  readonly transient: boolean;

  constructor(
    message: string,
    facts: { cause: unknown; entra_status: number | undefined; transient: boolean },
  ) {
    super(message);
    // GraphClientError resets the prototype to its own, which would break `instanceof` here.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'GraphTokenRequestError';
    this.cause = facts.cause;
    this.entra_status = facts.entra_status;
    this.transient = facts.transient;
  }
}

/** Classifies a failed token request: refused credentials, a transient failure, or neither. */
export function to_token_request_error(err: unknown): GraphTokenRequestError {
  const entra_status = find_entra_status(err);
  const oauth_code = find_oauth_code(err);
  const detail = describe_token_failure(entra_status, oauth_code);
  if (is_credential_refusal(entra_status)) {
    const refusal = new AuthError(
      `Microsoft Entra ID refused the Graph token request: ${detail}. Check the tenant ID, ` +
        'client ID and client secret, and that the secret has not expired.',
      { cause: err },
    );
    return new GraphTokenRequestError(refusal.message, {
      cause: refusal,
      entra_status,
      transient: false,
    });
  }
  return new GraphTokenRequestError(`Microsoft Entra ID did not issue a Graph token: ${detail}`, {
    cause: err,
    entra_status,
    transient: is_transient_token_failure(entra_status, oauth_code, err),
  });
}

/** The typed error a failed token request carries, when it carries one: `AuthError` on a refusal. */
export function token_request_refusal(err: unknown): AtlasError | undefined {
  if (!(err instanceof GraphTokenRequestError)) return undefined;
  return err.cause instanceof AtlasError ? err.cause : undefined;
}

/** Whether `err` is a token request that may succeed if repeated. */
export function is_transient_token_request_error(err: unknown): boolean {
  return err instanceof GraphTokenRequestError && err.transient;
}

/** Builds the `GraphUnavailableError` for a token request that kept failing through the budget. */
export function to_token_unavailable_error(
  err: GraphTokenRequestError,
  attempts: ExhaustedAttempts,
): GraphUnavailableError {
  return new GraphUnavailableError(
    `Microsoft Entra ID did not issue a Graph token after ${attempts.retries} retries over ` +
      `${Math.round(attempts.elapsed_ms / 1000)} s: ${err.message}`,
    attempts,
    { cause: err },
  );
}

/** A 4xx other than 408 and 429: Entra ID judged the tenant, client ID or secret and said no. */
function is_credential_refusal(status: number | undefined): boolean {
  return (
    status !== undefined && status >= 400 && status < 500 && !TRANSIENT_ENTRA_STATUSES.has(status)
  );
}

function is_transient_token_failure(
  status: number | undefined,
  oauth_code: string | undefined,
  err: unknown,
): boolean {
  if (status !== undefined) return status >= 500 || TRANSIENT_ENTRA_STATUSES.has(status);
  return oauth_code === MSAL_NETWORK_ERROR_CODE || is_network_error(err);
}

function describe_token_failure(
  status: number | undefined,
  oauth_code: string | undefined,
): string {
  const answer = status === undefined ? 'no response' : `HTTP ${status}`;
  return oauth_code === undefined ? answer : `${answer} (${oauth_code})`;
}

/**
 * Entra ID's HTTP status. MSAL's `ServerError` keeps it on `status`, and `@azure/identity`'s
 * `AuthenticationError` on `statusCode`; either can sit anywhere in the cause chain.
 */
function find_entra_status(err: unknown): number | undefined {
  for (const link of cause_chain(err)) {
    const status = link.status ?? link.statusCode;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return undefined;
}

/** The OAuth error code (`invalid_client`), from MSAL's `errorCode` or identity's `errorResponse`. */
function find_oauth_code(err: unknown): string | undefined {
  for (const link of cause_chain(err)) {
    if (typeof link.errorCode === 'string' && link.errorCode !== '') return link.errorCode;
    const response = link.errorResponse;
    if (typeof response === 'object' && response !== null) {
      const code = (response as Record<string, unknown>).error;
      if (typeof code === 'string' && code !== '') return code;
    }
  }
  return undefined;
}

function cause_chain(err: unknown): Record<string, unknown>[] {
  const links: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = err;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const link = current as Record<string, unknown>;
    links.push(link);
    current = link.cause;
  }
  return links;
}
