import { GraphUnavailableError } from '@wisecom/atlas-types';

/** How many retries an exhausted call made, and how long it spent before giving up. */
export interface ExhaustedAttempts {
  readonly retries: number;
  readonly elapsed_ms: number;
}

/**
 * Builds the `GraphUnavailableError` for a 5xx, network error or timeout that outlasted the retry
 * budget (issue #773), keeping the Graph error as `cause`.
 *
 * A failure that got no HTTP response carries no status and no Graph code. The Graph SDK wraps a
 * rejected `fetch` as `statusCode: -1` with the JavaScript error name (`TypeError`) as `code`, so
 * neither is copied for it: `status_code` and `graph_code` stay undefined and the message says no
 * response arrived. `describe_response` renders a failure that did get one.
 */
export function to_graph_unavailable_error(
  err: unknown,
  attempts: ExhaustedAttempts,
  describe_response: (err: unknown) => string,
): GraphUnavailableError {
  const status_code = http_status_of(err);
  const reason =
    status_code === undefined
      ? `no HTTP response (${describe_transport_failure(err)})`
      : describe_response(err);
  return new GraphUnavailableError(
    `Microsoft Graph was unavailable after ${attempts.retries} retries over ` +
      `${Math.round(attempts.elapsed_ms / 1000)} s: ${reason}`,
    attempts,
    {
      status_code,
      graph_code: status_code === undefined ? undefined : graph_code_of(err),
      cause: err,
    },
  );
}

/** The HTTP status of the response a failure carries, or undefined when no response arrived. */
function http_status_of(err: unknown): number | undefined {
  const status = field_of(err, 'statusCode');
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** Graph's error code on a Graph error, or undefined for a failure that carries none. */
function graph_code_of(err: unknown): string | undefined {
  const code = field_of(err, 'code');
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** The transport error's code and message, such as `ECONNRESET: read ECONNRESET`. */
function describe_transport_failure(err: unknown): string {
  const code = field_of(err, 'code');
  const message = err instanceof Error ? err.message : undefined;
  const parts = [code, message].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length > 0 ? parts.join(': ') : 'transport failure without details';
}

/** One field of an error object, or undefined for anything else. */
function field_of(err: unknown, key: string): unknown {
  return typeof err === 'object' && err !== null && key in err
    ? (err as Record<string, unknown>)[key]
    : undefined;
}
