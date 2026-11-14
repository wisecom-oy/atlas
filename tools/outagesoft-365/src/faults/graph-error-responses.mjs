/**
 * Synthetic error responses with the wire shapes Graph and Entra ID really use.
 *
 * Client code branches on these details: the status, the `error.code`, the
 * `innerError.code` for drives, whether Retry-After is present, and whether
 * the body is JSON at all. A generic 503 would test none of those branches.
 * Request ids in `innerError` are random GUIDs from the fault's sub-seed, so a
 * replay sends byte-identical bodies apart from the date.
 */
import { create_rng, rng_guid } from '../seeded-random.mjs';

const DRIVE_SERVICES = new Set(['onedrive', 'sharepoint', 'transfer']);

const IIS_QUEUE_FULL = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd">
<HTML><HEAD><TITLE>Service Unavailable</TITLE>
<META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></HEAD>
<BODY><h2>Service Unavailable</h2>
<hr><p>HTTP Error 503. The application request queue is full.</p>
</BODY></HTML>
`;

const CURSOR_PARAMS = /^(\$deltatoken|\$skiptoken|deltatoken|skiptoken|token)$/i;

/** A raw path with its delta or skip token removed and every other parameter ($select ...) kept. */
function without_cursor(raw_path) {
  const q = raw_path.indexOf('?');
  if (q === -1) return raw_path;
  const kept = raw_path
    .slice(q + 1)
    .split('&')
    .filter((pair) => pair && !CURSOR_PARAMS.test(pair.split('=')[0]));
  return kept.length ? `${raw_path.slice(0, q)}?${kept.join('&')}` : raw_path.slice(0, q);
}

/** Builds a Graph JSON error body with the innerError block Graph always includes. */
function graph_body(rng, code, message, inner_code) {
  const inner = {
    ...(inner_code ? { code: inner_code } : {}),
    date: new Date().toISOString().replace(/\.\d+Z$/, ''),
    'request-id': rng_guid(rng),
    'client-request-id': rng_guid(rng),
  };
  return JSON.stringify({ error: { code, message, innerError: inner } });
}

/** Throttling body by service: Exchange, drives and everything else word it differently. */
function throttle_body(rng, service) {
  if (service === 'outlook')
    return graph_body(
      rng,
      'ApplicationThrottled',
      'Application is over its MailboxConcurrency limit.',
    );
  if (DRIVE_SERVICES.has(service))
    return graph_body(
      rng,
      'activityLimitReached',
      'The request has been throttled',
      'throttledRequest',
    );
  return graph_body(rng, 'TooManyRequests', 'Please retry again later.');
}

/** Not-found body by service: directory and Exchange use their own codes. */
function not_found_body(rng, service) {
  if (service === 'directory') {
    return graph_body(
      rng,
      'Request_ResourceNotFound',
      `Resource '${rng_guid(rng)}' does not exist or one of its queried reference-property objects are not present.`,
    );
  }
  if (service === 'outlook')
    return graph_body(rng, 'ErrorItemNotFound', 'The specified object was not found in the store.');
  return graph_body(rng, 'itemNotFound', 'The resource could not be found.');
}

/** The status, headers and body of each synthetic fault, keyed by fault id. */
const BUILDERS = {
  throttle_429: (c) => json(429, throttle_body(c.rng, c.service), c.params.retry_after_s),
  throttle_429_no_retry_after: (c) => json(429, throttle_body(c.rng, c.service)),
  throttle_429_long_retry_after: (c) =>
    json(429, throttle_body(c.rng, c.service), c.params.retry_after_s),
  throttle_503: (c) =>
    json(
      503,
      graph_body(
        c.rng,
        'serviceNotAvailable',
        DRIVE_SERVICES.has(c.service)
          ? 'Server Too Busy'
          : 'Service unavailable, please retry later.',
      ),
      c.params.retry_after_s,
    ),
  server_500: (c) =>
    DRIVE_SERVICES.has(c.service)
      ? json(500, graph_body(c.rng, 'generalException', 'General exception while processing'))
      : json(500, graph_body(c.rng, 'InternalServerError', 'Internal server error')),
  bad_gateway_502: (c) => json(502, graph_body(c.rng, 'UnknownError', '')),
  unavailable_503: (c) =>
    json(503, graph_body(c.rng, 'serviceNotAvailable', 'Service is unavailable.')),
  gateway_timeout_504: (c) => json(504, graph_body(c.rng, 'UnknownError', '')),
  html_503: () => ({ status: 503, headers: { 'content-type': 'text/html' }, body: IIS_QUEUE_FULL }),
  mailbox_backend_503: (c) =>
    json(
      503,
      graph_body(
        c.rng,
        'MailboxInfoStale',
        `Target resource '${rng_guid(c.rng)}' hosted on database '${rng_guid(c.rng)}' is currently on backend 'Unknown'`,
      ),
    ),
  spurious_401: (c) => ({
    ...json(
      401,
      graph_body(
        c.rng,
        'InvalidAuthenticationToken',
        'Lifetime validation failed, the token is expired.',
      ),
    ),
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
  }),
  spurious_400: (c) => json(400, graph_body(c.rng, 'invalidRequest', 'Invalid request')),
  transient_404: (c) => json(404, not_found_body(c.rng, c.service)),
  locked_423: (c) =>
    json(
      423,
      graph_body(
        c.rng,
        'notAllowed',
        'The resource you are attempting to access is locked',
        'resourceLocked',
      ),
    ),
  delta_resync_410: (c) => {
    const drive = DRIVE_SERVICES.has(c.service);
    const body = drive
      ? graph_body(
          c.rng,
          'resyncRequired',
          "Resync required. Replace any local items with the server's version (including deletes) if you're sure that the service was up to date with your local changes when you last sync'd. Upload any local changes that the server doesn't know about.",
          'resyncChangesApplyDifferences',
        )
      : graph_body(c.rng, 'resyncRequired', 'Resync required.');
    // The client restarts from Location: the same delta request with only its cursor dropped.
    return {
      ...json(410, body),
      headers: {
        'content-type': 'application/json',
        location: `${c.origin}${without_cursor(c.path)}`,
      },
    };
  },
  delta_token_expired: (c) =>
    json(
      c.params.status ?? 410,
      graph_body(
        c.rng,
        'syncStateNotFound',
        'The sync state generation is not found. Delta token is expired or invalid.',
      ),
    ),
  upload_session_gone_404: (c) =>
    json(
      404,
      graph_body(
        c.rng,
        'itemNotFound',
        'The upload session was not found',
        'uploadSessionNotFound',
      ),
    ),
  upload_fragment_416: (c) =>
    json(
      416,
      graph_body(
        c.rng,
        'invalidRange',
        'The uploaded fragment overlaps with data that has already been received.',
        'fragmentOverlap',
      ),
    ),
  download_url_expired_401: () =>
    json(401, JSON.stringify({ error: { code: 'unauthenticated', message: 'JWT Token Expired' } })),
  token_endpoint_503: () =>
    json(
      503,
      JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: 'AADSTS90033: A transient error has occurred. Please try again.',
        error_codes: [90033],
      }),
    ),
  token_endpoint_429: (c) =>
    json(
      429,
      JSON.stringify({
        error: 'invalid_request',
        error_description: 'Too many requests. Please retry later.',
      }),
      c.params.retry_after_s ?? 60,
    ),
};

/** A JSON response, with Retry-After when a wait is advised. */
function json(status, body, retry_after_s) {
  const headers = { 'content-type': 'application/json' };
  if (retry_after_s !== undefined) headers['retry-after'] = String(retry_after_s);
  return { status, headers, body };
}

/** True when `fault_id` is answered with a synthetic HTTP response. */
export function has_synthetic_response(fault_id) {
  return fault_id in BUILDERS;
}

/**
 * Builds the synthetic response for a fault. `context` is { service, params, origin, path };
 * origin and path only feed a Location header sent to the client, never the journal.
 */
export function build_error_response(fault_id, context) {
  const rng = create_rng(`body\u0000${context.params?.sub_seed ?? ''}`);
  const response = BUILDERS[fault_id]({ ...context, params: context.params ?? {}, rng });
  const retry_after = response.headers['retry-after'];
  return {
    ...response,
    retry_after_s: retry_after === undefined ? undefined : Number(retry_after),
  };
}

/** Pulls the error code out of a JSON error body: Graph's `error.code` or OAuth's `error`. */
export function extract_error_code(text) {
  try {
    const body = JSON.parse(text);
    const code = typeof body?.error === 'string' ? body.error : body?.error?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
