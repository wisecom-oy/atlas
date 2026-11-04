/**
 * Fake Microsoft Graph HTTP server for the Teams endpoints.
 *
 * Routes are matched first, so unknown paths never spend limiter tokens. Every matched request is
 * admitted or throttled by the token buckets, and counted in the request stats either way.
 */
import { createServer } from 'node:http';
import { match_route } from './routes-teams.mjs';
import { GraphHttpError } from './paging.mjs';
import { create_rate_limiter, teams_limits } from './rate-limiter.mjs';
import { create_request_stats } from './request-stats.mjs';

/**
 * Starts the server on 127.0.0.1.
 * @param {{tenant: object, time_scale?: number, port?: number}} options
 */
export async function start_fake_graph_server({ tenant, time_scale = 1, port = 0 }) {
  const limiter = create_rate_limiter(teams_limits(time_scale));
  const stats = create_request_stats();
  let reject_unrouted;
  const unrouted = new Promise((_, reject) => {
    reject_unrouted = reject;
  });
  unrouted.catch(() => {});
  const on_unrouted = (where) => {
    process.stderr.write(`rig: no route for ${where}\n`);
    reject_unrouted(new Error(`fake Graph has no route for ${where}`));
  };
  const server = createServer((req, res) => {
    handle(req, res, { tenant, limiter, stats, on_unrouted }).catch((err) => {
      send_json(res, 500, error_body('InternalServerError', String(err?.message ?? err)));
    });
  });
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    time_scale,
    stats,
    // Rejects on the first request no route matches; scenarios race their runs against it.
    unrouted,
    limiter,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Serves one request. */
async function handle(req, res, { tenant, limiter, stats, on_unrouted }) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  if (segments[0] === 'v1.0') segments.shift();
  const matched = match_route(req.method ?? 'GET', segments);
  if (!matched) {
    on_unrouted(`${req.method ?? 'GET'} ${url.pathname}`);
    return send_json(res, 404, error_body('ResourceNotFound', 'no route'));
  }

  const { route, params } = matched;
  const verdict = limiter.admit({ cls: route.cls, team: params.team, channel: params.channel });
  stats.record(route.cls, params.team, verdict.ok, route.handler.name);
  if (!verdict.ok) {
    res.setHeader('Retry-After', String(verdict.retry_after_s));
    return send_json(res, 429, error_body('TooManyRequests', 'throttled'));
  }
  if (route.cls === 'messages' && params.channel) stats.touch_channel(params.channel);

  try {
    const result = await route.handler({ tenant, params, query: url.searchParams, segments });
    if (result.bytes) {
      stats.record_hosted(result.bytes.length, params.hosted);
      res.writeHead(200, {
        'Content-Type': result.content_type,
        'Content-Length': result.bytes.length,
      });
      return res.end(result.bytes);
    }
    return send_json(res, result.status ?? 200, result.json);
  } catch (err) {
    if (err instanceof GraphHttpError)
      return send_json(res, err.status, error_body(err.code, err.code));
    throw err;
  }
}

/** Graph error envelope. */
function error_body(code, message) {
  return { error: { code, message } };
}

/** Writes a JSON response. */
function send_json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}
