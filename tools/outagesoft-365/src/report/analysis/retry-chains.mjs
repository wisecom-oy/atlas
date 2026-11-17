/**
 * Groups attempts on the same URL into retry chains, in arrival order.
 *
 * A chain starts at an attempt the client could not use (a failure) and collects every later
 * attempt with the same `retry_key` until one is usable. Polling a URL that never failed therefore
 * never forms a chain, and polling after a recovery starts nothing new. `retry_key` is the
 * `url_key` (method and full URL) plus the request body digest when the journal records one, so
 * two different POSTs to one URL stay apart and a re-sent write with the same body stays together.
 * Journals without `body_key` group by URL alone, and two distinct POSTs then look identical.
 *
 * A re-request is inferred to be a retry. The relay's `occurrence` counter turns that into a count:
 * when every attempt in a chain carries the next occurrence of the same identity, no other request
 * for that identity came in between, and the chain is marked `counted`.
 *
 * Results:
 *   recovered     retried and a later attempt was usable
 *   unrecovered   retried, and every attempt up to the end of the journal failed
 *   not_retried   the failing attempt was never requested again
 *
 * The builder is fed attempts in arrival order and keeps state only for URLs with an open chain
 * or an attempt awaiting its successor, so memory follows the number of open chains.
 */
import { classify_attempt } from './fault-knowledge.mjs';
import { fault_applied } from './traffic-aggregates.mjs';

const MAX_ATTEMPTS_KEPT = 50;

/** Label for what started a chain: the fault id, or what the upstream or client did without one. */
export function origin_label(attempt) {
  if (fault_applied(attempt)) return attempt.fault_id;
  if (attempt.status && attempt.status >= 400 && attempt.outcome === 'complete') {
    return `upstream ${attempt.status}`;
  }
  return `no fault (${attempt.status ? `${attempt.status}+` : ''}${attempt.error ?? attempt.outcome})`;
}

function compact_attempt(a, cls) {
  return {
    t: a.t,
    occurrence: a.occurrence,
    total_ms: a.total_ms,
    fault_id: fault_applied(a) ? a.fault_id : null,
    status: a.status,
    outcome: a.outcome,
    error: a.error,
    retry_after_s: a.retry_after_s,
    cls,
  };
}

function open_chain(a, cls) {
  return {
    url_key: a.url_key,
    body_key: a.body_key ?? null,
    identity_key: a.identity_key,
    method: a.method,
    url: a.url,
    shape_key: a.shape_key,
    service: a.service,
    kind: a.kind,
    idempotent: a.idempotent,
    origin: {
      label: origin_label(a),
      fault_id: fault_applied(a) ? a.fault_id : null,
      source: fault_applied(a) ? a.fault_source : null,
      category: a.fault_category,
    },
    start_t: a.t,
    last_t: a.t,
    attempts: [compact_attempt(a, cls)],
    attempt_count: 1,
    counted: a.occurrence !== null,
    last_occurrence: a.occurrence,
    result: null,
    recovered_t: null,
  };
}

function append_attempt(chain, a, cls) {
  chain.attempt_count += 1;
  chain.last_t = a.t;
  const consecutive = chain.last_occurrence !== null && a.occurrence === chain.last_occurrence + 1;
  chain.counted = chain.counted && consecutive;
  chain.last_occurrence = a.occurrence;
  if (chain.attempts.length < MAX_ATTEMPTS_KEPT) chain.attempts.push(compact_attempt(a, cls));
}

/**
 * Creates a streaming chain builder.
 * `on_chain(chain)` receives each finished chain; `on_relation(relation)` receives, for every failed
 * or altered attempt, what came next on the same URL (`next` is null when nothing did).
 */
export function create_chain_builder(on_chain, on_relation) {
  const states = new Map();

  function relate(state, next) {
    const from = state.last;
    const gap_ms = next ? next.t - (from.t + from.total_ms) : null;
    on_relation({
      from,
      next,
      chain_index: state.last_chain_index,
      gap_ms,
      overlapped: gap_ms !== null && gap_ms < 0,
    });
  }

  function add(a) {
    const state = states.get(a.retry_key) ?? { chain: null, last: null, last_chain_index: null };
    const cls = classify_attempt(a);
    if (state.last) relate(state, a);
    if (state.chain) {
      append_attempt(state.chain, a, cls);
      if (cls !== 'failure') {
        state.chain.result = 'recovered';
        state.chain.recovered_t = a.t;
        on_chain(state.chain);
        state.chain = null;
      }
    } else if (cls === 'failure') {
      state.chain = open_chain(a, cls);
    }
    state.last = cls === 'clean' ? null : a;
    state.last_chain_index =
      state.chain && cls === 'failure' ? state.chain.attempt_count - 1 : null;
    if (state.chain || state.last) states.set(a.retry_key, state);
    else states.delete(a.retry_key);
  }

  function finish() {
    for (const state of states.values()) {
      if (state.last) relate(state, null);
      if (state.chain) {
        state.chain.result = state.chain.attempt_count > 1 ? 'unrecovered' : 'not_retried';
        on_chain(state.chain);
      }
    }
    states.clear();
  }

  return { add, finish };
}

/** Builds chains and relations from an array of attempts in any order (convenience for tests). */
export function build_retry_chains(attempts) {
  const chains = [];
  const relations = [];
  const builder = create_chain_builder(
    (c) => chains.push(c),
    (r) => relations.push(r),
  );
  const sorted = [...attempts].sort((a, b) => a.t - b.t || a.seq - b.seq);
  for (const a of sorted) builder.add(a);
  builder.finish();
  return { chains, relations };
}
