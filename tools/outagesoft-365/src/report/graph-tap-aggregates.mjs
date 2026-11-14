/**
 * The figures a `graph-tap summary` prints, computed from the outagesoft journal.
 *
 * Under outagesoft, graph-tap sees the relay origin and cannot run alongside it, so this block is
 * the stand-in: the same status keys (`200`, `503+failed`, `failed`), the same THROTTLING, ERRORS
 * and SLOWEST rules, so a simulated run can be laid beside a graph-tap capture of a real incident.
 * The figures describe what the client received, which is what graph-tap records.
 */
import {
  add_to_histogram,
  bump,
  create_histogram,
  ranked_counts,
  summarise_histogram,
} from './number-summary.mjs';

const MAX_RETRY_AFTER_VALUES = 20;
const MAX_ERROR_URLS = 20;
const SLOWEST_KEPT = 3;

/** Status key with graph-tap's vocabulary: `failed` alone means no status ever arrived. */
export function graph_tap_status_key(attempt) {
  if (attempt.outcome === 'complete') return String(attempt.status);
  return attempt.status ? `${attempt.status}+failed` : 'failed';
}

function error_code(a) {
  if (a.outcome !== 'complete') {
    // graph-tap names a failure by the client's error text; the relay records it as delivered.error.
    const reason = a.error ?? a.outcome;
    return a.status ? `${a.status} body: ${reason}` : `transport: ${reason}`;
  }
  return `${a.status} ${a.graph_error ?? '(no code)'}`;
}

function is_throttle_status(status) {
  return status === 429 || status === 503;
}

function keep_slowest(slowest, a) {
  if (slowest.length === SLOWEST_KEPT && a.total_ms <= slowest[SLOWEST_KEPT - 1].ms) return;
  slowest.push({ ms: a.total_ms, status: graph_tap_status_key(a), method: a.method, url: a.url });
  slowest.sort((x, y) => y.ms - x.ms);
  slowest.length = Math.min(slowest.length, SLOWEST_KEPT);
}

/** Creates the accumulator for graph-tap compatible figures. */
export function create_graph_tap_aggregates() {
  const by_status = new Map();
  const shapes = new Map();
  const throttles = new Map();
  const errors = new Map();
  const slowest = [];

  function add_shape(a, status_key) {
    let shape = shapes.get(a.shape_key);
    if (!shape) {
      shape = {
        method: a.method,
        url: a.url,
        count: 0,
        statuses: new Map(),
        ms: create_histogram(),
        rx: 0,
        tx: 0,
      };
      shapes.set(a.shape_key, shape);
    }
    shape.count += 1;
    shape.rx += a.bytes;
    shape.tx += a.req_bytes;
    bump(shape.statuses, status_key);
    add_to_histogram(shape.ms, a.total_ms);
  }

  function add_throttle(a) {
    let entry = throttles.get(a.shape_key);
    if (!entry)
      throttles.set(
        a.shape_key,
        (entry = { key: a.shape_key, count: 0, retry_after_s: new Set() }),
      );
    entry.count += 1;
    if (a.retry_after_s !== null && entry.retry_after_s.size < MAX_RETRY_AFTER_VALUES) {
      entry.retry_after_s.add(a.retry_after_s);
    }
  }

  function add_error(a) {
    const code = error_code(a);
    let entry = errors.get(code);
    if (!entry) errors.set(code, (entry = { code, count: 0, urls: new Set() }));
    entry.count += 1;
    if (entry.urls.size < MAX_ERROR_URLS) entry.urls.add(a.url.split('?')[0]);
  }

  function add(a) {
    const status_key = graph_tap_status_key(a);
    bump(by_status, status_key);
    add_shape(a, status_key);
    if (is_throttle_status(a.status)) add_throttle(a);
    const failed = a.outcome !== 'complete';
    if (failed || (!is_throttle_status(a.status) && a.status >= 400)) add_error(a);
    keep_slowest(slowest, a);
  }

  function finish() {
    return {
      by_status: ranked_counts(by_status),
      shapes: [...shapes.values()]
        .sort((x, y) => y.count - x.count)
        .map((s) => ({ ...s, statuses: ranked_counts(s.statuses), ms: summarise_histogram(s.ms) })),
      throttling: [...throttles.values()]
        .sort((x, y) => y.count - x.count)
        .map((t) => ({ ...t, retry_after_s: [...t.retry_after_s].sort((x, y) => x - y) })),
      errors: [...errors.values()]
        .sort((x, y) => y.count - x.count)
        .map((e) => ({ ...e, urls: [...e.urls] })),
      slowest,
    };
  }

  return { add, finish };
}
