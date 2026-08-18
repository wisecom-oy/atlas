/**
 * graph-tap: records every HTTP request Atlas sends to Microsoft Graph.
 *
 * Loaded with `node --import`, so it observes the real process without a proxy,
 * a CA certificate, or elevated privileges. Every Graph call in Atlas goes
 * through global `fetch` -- the Graph SDK's HTTPMessageHandler calls it directly,
 * and the OneDrive/SharePoint chunked transfer paths call it themselves -- and
 * global `fetch` is undici, which publishes its request lifecycle on
 * node:diagnostics_channel. Subscribing there sees all of it.
 *
 * Output is written for an LLM to read, so it is deliberately lean: an allowlist
 * of diagnostically useful headers rather than everything undici reports, opaque
 * tokens elided down to their byte count, and IDs templated so repeated calls
 * collapse into one shape in `graph-tap summary`.
 *
 * Subscriber callbacks run synchronously inside undici and must never throw,
 * so every handler body is wrapped.
 */
import dc from 'node:diagnostics_channel';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { brotliDecompressSync, constants, gunzipSync, inflateSync } from 'node:zlib';

/** Hosts worth recording. Anything else (S3, MinIO, telemetry) is ignored. */
const DEFAULT_HOSTS = String.raw`graph\.microsoft\.com|login\.microsoftonline\.com|\.sharepoint\.com|1drv\.(com|ms)|officeapps\.live\.com`;

/**
 * The only response headers kept. Everything else undici reports -- ags
 * diagnostics, HSTS, trace IDs, CORS preflight noise -- is bloat for analysis.
 * This list is throttling and shape information, which is what Graph problems
 * actually turn out to be.
 */
const KEEP_RESPONSE_HEADERS = new Set([
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-ms-throttle-limit-percentage',
  'x-ms-throttle-scope',
  'x-ms-throttle-information',
  'x-ms-resource-unit',
  'content-type',
  'location',
]);

/** Request headers kept. Never `authorization`: it is a live bearer token. */
const KEEP_REQUEST_HEADERS = new Set([
  'content-type',
  'content-range',
  'range',
  'prefer',
  'if-match',
]);

/**
 * Query parameters whose values are opaque and enormous: delta and skip tokens
 * run to kilobytes, and `tempauth`/`guestaccesstoken` on pre-authenticated
 * download URLs are credentials that grant file access on their own. Both are
 * replaced by their byte count, which is all an analysis needs.
 */
const ELIDE_PARAMS =
  /^(\$deltatoken|\$skiptoken|\$skip|token|tempauth|guestaccesstoken|access_token|id_token|refresh_token|code|client_secret|password|sig|se|sp|sv|skoid|st|spr|sr|nonce|state|cv|authkey)$/i;

/** Longest a single kept query value may be before it is truncated. */
const MAX_PARAM_LEN = 160;

const host_filter = new RegExp(process.env.GRAPH_TAP_HOSTS || DEFAULT_HOSTS, 'i');
const capture_all = process.env.GRAPH_TAP_ALL === '1';
const capture_bodies = process.env.GRAPH_TAP_BODIES === '1';
const capture_headers = process.env.GRAPH_TAP_HEADERS === '1';
const body_limit = Number(process.env.GRAPH_TAP_BODY_LIMIT || 2048);
const quiet = process.env.GRAPH_TAP_QUIET === '1';
const out_path =
  process.env.GRAPH_TAP_OUT || `.graph-tap/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

/** Error payloads are always read, capped: a Graph error code is the whole point. */
const ERROR_BODY_LIMIT = 2048;

mkdirSync(dirname(out_path), { recursive: true });
const fd = openSync(out_path, 'a');
const run_started = Date.now();

/** Per-request state, keyed by the request object undici shares across channels. */
const tracked = new WeakMap();
const totals = { requests: 0, by_status: {}, rx: 0, tx: 0 };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collapses a path into a shape: concrete identifiers become placeholders so
 * thousands of per-message calls group into one row instead of one row each.
 */
function template_path(path) {
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (GUID.test(seg)) return '{guid}';
      if (seg.includes('@') && seg.includes('.')) return '{upn}';
      // Outlook item ids, drive item ids and site ids: long and opaque.
      if (seg.length > 40) return '{id}';
      if (/^\d+$/.test(seg) && seg.length > 3) return '{n}';
      if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return '{id}';
      return seg;
    })
    .join('/');
}

/** Elides credential and cursor values, keeping their size, and templates ids. */
function normalize_url(origin, full_path) {
  const q = full_path.indexOf('?');
  const path = template_path(q === -1 ? full_path : full_path.slice(0, q));
  const host = origin.replace(/^https?:\/\//, '');
  if (q === -1) return `${host}${path}`;

  const params = full_path
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (ELIDE_PARAMS.test(decodeURIComponent(key))) return `${key}=<${value.length}b>`;
      const decoded = decodeURIComponent(value);
      return `${key}=${decoded.length > MAX_PARAM_LEN ? `${decoded.slice(0, MAX_PARAM_LEN)}…` : decoded}`;
    });
  return `${host}${path}?${params.join('&')}`;
}

/** Picks an allowlisted subset out of undici's flat name/value header arrays. */
function pick_headers(raw, allow) {
  const out = {};
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < raw.length - 1; i += 2) {
    const name = String(raw[i]).toLowerCase();
    if (allow.has(name)) out[name] = String(raw[i + 1]);
  }
  return out;
}

/** Reads one header value out of undici's flat name/value array. */
function header_value(raw, name) {
  if (!Array.isArray(raw)) return undefined;
  for (let i = 0; i < raw.length - 1; i += 2) {
    if (String(raw[i]).toLowerCase() === name) return String(raw[i + 1]).toLowerCase();
  }
  return undefined;
}

/**
 * Decodes a response body captured off the wire.
 *
 * Graph gzips its error payloads, and diagnostics_channel hands over the raw
 * compressed bytes, so without this the error code -- the single most useful
 * field in a capture -- is binary noise. Z_SYNC_FLUSH lets a body that hit the
 * capture cap still decode instead of throwing on a truncated stream.
 */
function decode_body(buffer, encoding) {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return gunzipSync(buffer, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
    }
    if (encoding === 'deflate') {
      return inflateSync(buffer, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
    }
    if (encoding === 'br') {
      return brotliDecompressSync(buffer, {
        finishFlush: constants.BROTLI_OPERATION_FLUSH,
      }).toString('utf8');
    }
  } catch {
    /* fall through: a partial or unexpected encoding is better shown raw */
  }
  return buffer.toString('utf8');
}

/**
 * Pulls `error.code` and `error.message` out of a Graph error payload.
 *
 * Messages are flattened to one line and clipped: Graph pads some of them with
 * multi-line token diagnostics that add nothing to an analysis.
 */
function parse_graph_error(text) {
  const one_line = (s) => s.replace(/\s+/g, ' ').trim();
  try {
    const body = JSON.parse(text);
    const err = body?.error ?? body;
    if (!err) return undefined;
    const code = err.code ?? err.error;
    const message = typeof err.message === 'string' ? err.message : err.message?.value;
    if (!code && !message) return undefined;
    return { code, message: message ? one_line(message).slice(0, 200) : undefined };
  } catch {
    const trimmed = one_line(text).slice(0, 160);
    return trimmed ? { message: trimmed } : undefined;
  }
}

/** Wraps a subscriber so a bug here can never break the process it observes. */
function safely(handler) {
  return (message) => {
    try {
      handler(message);
    } catch {
      /* observation must never affect the observed process */
    }
  };
}

function finish(request, extra) {
  const slot = tracked.get(request);
  if (!slot || slot.done) return;
  slot.done = true;

  const record = {
    t: slot.started - run_started,
    method: slot.method,
    url: slot.url,
    ...extra,
    ms: Math.round(performance.now() - slot.clock),
  };
  if (slot.tx) record.tx = slot.tx;
  if (slot.rx) record.rx = slot.rx;

  const res_headers = pick_headers(slot.res_headers, KEEP_RESPONSE_HEADERS);
  // content-type is only interesting when it is not the usual JSON.
  if (res_headers['content-type']?.startsWith('application/json'))
    delete res_headers['content-type'];
  if (Object.keys(res_headers).length) record.res_headers = res_headers;

  if (capture_headers) {
    const req_headers = pick_headers(slot.req_headers, KEEP_REQUEST_HEADERS);
    if (Object.keys(req_headers).length) record.req_headers = req_headers;
  }

  if (slot.status >= 400 && slot.error_chunks.length) {
    const encoding = header_value(slot.res_headers, 'content-encoding');
    const parsed = parse_graph_error(decode_body(Buffer.concat(slot.error_chunks), encoding));
    if (parsed) record.graph_error = parsed;
  }
  if (capture_bodies && slot.body) record.body = slot.body;

  writeSync(fd, `${JSON.stringify(record)}\n`);

  totals.requests += 1;
  totals.tx += slot.tx;
  totals.rx += slot.rx;
  const key = record.failed ? 'failed' : String(record.status);
  totals.by_status[key] = (totals.by_status[key] || 0) + 1;

  if (!quiet) {
    const label = record.failed ? `ERR ${record.failed}` : record.status;
    const detail = record.graph_error?.code ? ` ${record.graph_error.code}` : '';
    process.stderr.write(
      `[graph-tap] ${label}${detail} ${record.method} ${record.url} ${record.ms}ms\n`,
    );
  }
}

dc.channel('undici:request:create').subscribe(
  safely(({ request }) => {
    const origin = String(request.origin);
    if (!capture_all && !host_filter.test(origin)) return;
    tracked.set(request, {
      started: Date.now(),
      clock: performance.now(),
      method: request.method,
      url: normalize_url(origin, request.path),
      req_headers: request.headers,
      tx: 0,
      rx: 0,
      body: '',
      error_chunks: [],
      error_bytes: 0,
      done: false,
    });
  }),
);

dc.channel('undici:request:bodyChunkSent').subscribe(
  safely(({ request, chunk }) => {
    const slot = tracked.get(request);
    if (!slot) return;
    slot.tx += chunk.length;
    if (capture_bodies && slot.body.length < body_limit) {
      slot.body += Buffer.from(chunk)
        .subarray(0, body_limit - slot.body.length)
        .toString('utf8');
    }
  }),
);

dc.channel('undici:request:headers').subscribe(
  safely(({ request, response }) => {
    const slot = tracked.get(request);
    if (!slot) return;
    slot.status = response.statusCode;
    slot.res_headers = response.headers;
  }),
);

dc.channel('undici:request:bodyChunkReceived').subscribe(
  safely(({ request, chunk }) => {
    const slot = tracked.get(request);
    if (!slot) return;
    slot.rx += chunk.length;
    // Only error payloads are buffered: a 512 MiB file download must not be.
    // Kept as raw bytes because Graph gzips them; decoding happens in finish().
    if (slot.status >= 400 && slot.error_bytes < ERROR_BODY_LIMIT) {
      const room = ERROR_BODY_LIMIT - slot.error_bytes;
      slot.error_chunks.push(Buffer.from(chunk).subarray(0, room));
      slot.error_bytes += Math.min(room, chunk.length);
    }
  }),
);

dc.channel('undici:request:trailers').subscribe(
  safely(({ request }) => {
    const slot = tracked.get(request);
    if (slot) finish(request, { status: slot.status });
  }),
);

dc.channel('undici:request:error').subscribe(
  safely(({ request, error }) => {
    if (tracked.has(request))
      finish(request, { failed: String(error?.message || error).slice(0, 120) });
  }),
);

process.on('exit', () => {
  if (quiet) return;
  const statuses = Object.entries(totals.by_status)
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');
  process.stderr.write(
    `[graph-tap] ${totals.requests} requests (${statuses || 'none'}), ` +
      `tx ${totals.tx}B rx ${totals.rx}B -> ${out_path}\n`,
  );
});
