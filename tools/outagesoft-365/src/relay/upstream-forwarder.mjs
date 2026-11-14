/**
 * Streaming forward of one request to the real upstream (or to --upstream).
 *
 * Bodies are piped in both directions and never buffered here. The request
 * keeps its headers, bearer token included, except for hop-by-hop headers and
 * the test-only force header, and `host` is set for the target. Real upstreams
 * are reached over TLS with Node's default certificate validation; the relay
 * never relaxes it.
 *
 * Upstream body bytes are counted by `read_upstream_body`, the one reader every
 * consumer uses, because attaching a separate `data` listener would switch the
 * stream to flowing mode and lose chunks for a consumer that starts later.
 */
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { decode_content } from './body-encoding.mjs';
import { count_request_chunk, on_exchange_end } from './exchange.mjs';
import { extract_error_code } from '../faults/graph-error-responses.mjs';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** Header the selfcheck uses to force a fault; never forwarded. */
export const FORCE_HEADER = 'x-outagesoft-force';

/** Most error-body bytes kept in memory to read a Graph error code from. */
const ERROR_SNIFF_BYTES = 4096;

/** Copies headers minus hop-by-hop ones and any named in Connection. */
export function strip_hop_by_hop(headers) {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || listed.has(lower) || lower === FORCE_HEADER) continue;
    out[name] = value;
  }
  return out;
}

/** Creates keep-alive agents for upstream connections; `destroy()` closes their sockets. */
export function create_upstream_agents() {
  const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  };
  return { ...agents, destroy: () => (agents.http.destroy(), agents.https.destroy()) };
}

/** Resolves where a request goes: its own origin, or the --upstream base with the path appended. */
function resolve_target(ex, upstream_base) {
  const base = new URL(upstream_base ?? ex.origin);
  const base_path = upstream_base ? base.pathname.replace(/\/$/, '') : '';
  // The raw path is appended as-is: re-parsing it through URL could re-encode it.
  return { url: base, path: `${base_path}${ex.path}` };
}

/** Short, data-free description of a transport error for the journal. */
export function transport_error_code(error) {
  return String(error?.code ?? error?.name ?? 'error').slice(0, 40);
}

/** Forwards the request and resolves with the upstream response once its headers arrive. */
export function forward_request(ex, { agents, upstream_base }) {
  const { url, path } = resolve_target(ex, upstream_base);
  const secure = url.protocol === 'https:';
  const headers = { ...strip_hop_by_hop(ex.req.headers), host: url.host };
  ex.forwarded = true;
  ex.upstream = { status: null, first_byte_ms: null, total_ms: null, bytes: 0 };
  ex.upstream_started = performance.now();

  const up_req = (secure ? https : http).request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (secure ? 443 : 80),
    path,
    method: ex.req.method,
    headers,
    agent: secure ? agents.https : agents.http,
  });
  on_exchange_end(ex, () => up_req.destroy());
  if (ex.body_buffer) {
    // A pre-read JSON body: already counted and digested, sent unchanged.
    up_req.end(ex.body_buffer);
  } else {
    ex.req.on('data', (chunk) => count_request_chunk(ex, chunk));
    ex.req.pipe(up_req);
  }

  return new Promise((resolve, reject) => {
    up_req.once('response', (up_res) => {
      ex.upstream.status = up_res.statusCode;
      ex.upstream.first_byte_ms = Math.round(performance.now() - ex.upstream_started);
      // A stream error with no listener is an uncaught exception; readers see errors via iteration.
      up_res.on('error', () => {});
      on_exchange_end(ex, () => up_res.destroy());
      resolve(up_res);
    });
    // `on`, not `once`: a second error after the first must not crash the relay.
    up_req.on('error', (error) => {
      if (ex.upstream.status === null && !ex.upstream.error && !ex.client_gone) {
        ex.upstream.error = transport_error_code(error);
        ex.upstream.total_ms = Math.round(performance.now() - ex.upstream_started);
      }
      reject(error);
    });
  });
}

/** Records the error code of a sniffed error body, if it parses. */
function record_error_code(ex, up_res, chunks) {
  try {
    const decoded = decode_content(Buffer.concat(chunks), up_res.headers['content-encoding'], true);
    if (decoded) ex.upstream_error_code = extract_error_code(decoded.toString('utf8'));
  } catch {
    /* an undecodable error body simply has no code to report */
  }
}

/**
 * Yields the upstream body chunk by chunk, counting bytes and timing, and
 * keeping the first few KiB of an error body to read its error code from.
 */
export async function* read_upstream_body(ex, up_res) {
  const is_error = up_res.statusCode >= 400;
  const sniffed = [];
  let sniffed_bytes = 0;
  try {
    for await (const chunk of up_res) {
      ex.upstream.bytes += chunk.length;
      if (is_error && sniffed_bytes < ERROR_SNIFF_BYTES) {
        sniffed.push(chunk.subarray(0, ERROR_SNIFF_BYTES - sniffed_bytes));
        sniffed_bytes += Math.min(chunk.length, ERROR_SNIFF_BYTES - sniffed_bytes);
      }
      yield chunk;
    }
  } catch (error) {
    if (!ex.client_gone) ex.upstream.error = transport_error_code(error);
    throw error;
  } finally {
    ex.upstream.total_ms ??= Math.round(performance.now() - ex.upstream_started);
    if (sniffed.length) record_error_code(ex, up_res, sniffed);
  }
}

/** Response headers to pass to the client: the upstream's, minus hop-by-hop ones. */
export function client_response_headers(up_res) {
  return strip_hop_by_hop(up_res.headers);
}
