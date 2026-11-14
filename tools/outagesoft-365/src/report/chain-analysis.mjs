/**
 * Summarises finished retry chains: outcome per fault, client timeouts, and backoff shape.
 *
 * Gaps are measured from the end of the failed exchange as the relay saw it (arrival plus
 * delivered time) to the arrival of the next attempt, which is the wait the client chose. A
 * negative gap means the client re-sent before the relay had finished the previous exchange, the
 * signature of a timeout implemented by racing a promise; those are reported apart and excluded
 * from backoff statistics.
 */
import { bump, median, ranked_counts, summarise_list } from './number-summary.mjs';
import { fault_category } from './fault-knowledge.mjs';

const CHAIN_DETAIL_LIMIT = 2000;
const IMMEDIATE_RETRY_MS = 100;
const FAST_RETRY_MS = 1000;
const EXAMPLE_LIMIT = 5;

function is_backoff_trigger(attempt) {
  return (
    attempt.cls === 'failure' &&
    attempt.retry_after_s === null &&
    (attempt.status === 429 || attempt.status >= 500)
  );
}

/** Gaps after each 429 or 5xx that carried no Retry-After, in chain order. */
export function gaps_without_retry_after(chain) {
  const gaps = [];
  for (let i = 0; i + 1 < chain.attempts.length; i += 1) {
    const a = chain.attempts[i];
    if (is_backoff_trigger(a)) gaps.push(chain.attempts[i + 1].t - (a.t + a.total_ms));
  }
  return gaps;
}

/**
 * True when a chain's retries after 429/5xx without Retry-After show no backoff: one retry within
 * 100 ms, or at least two retries all within one second whose gaps never grow.
 */
export function is_hammering(gaps) {
  if (gaps.some((g) => g >= 0 && g < IMMEDIATE_RETRY_MS)) return true;
  if (gaps.length < 2 || gaps.some((g) => g < 0 || g >= FAST_RETRY_MS)) return false;
  return gaps.every((g, i) => i === 0 || g <= gaps[i - 1]);
}

function create_origin(chain) {
  return {
    label: chain.origin.label,
    fault_id: chain.origin.fault_id,
    category: chain.origin.fault_id
      ? fault_category(chain.origin.fault_id, chain.origin.category)
      : 'not injected',
    injected: Boolean(chain.origin.fault_id),
    chains: 0,
    recovered: 0,
    unrecovered: 0,
    not_retried: 0,
    counted: 0,
    attempts_to_clean: [],
    recover_ms: [],
  };
}

function origin_to_json(o) {
  return {
    label: o.label,
    fault_id: o.fault_id,
    category: o.category,
    injected: o.injected,
    chains: o.chains,
    recovered: o.recovered,
    unrecovered: o.unrecovered,
    not_retried: o.not_retried,
    retried_counted_by_occurrence: o.counted,
    attempts_to_clean: summarise_list(o.attempts_to_clean),
    recover_ms: summarise_list(o.recover_ms),
  };
}

/** Creates the accumulator for finished chains. */
export function create_chain_analysis() {
  const origins = new Map();
  const shapes = new Map();
  const timeouts = new Map();
  const backoff = {
    all: [],
    self_chosen: [],
    by_step: new Map(),
    hammering: 0,
    measured_chains: 0,
    examples: new Set(),
  };
  const details = [];
  let total = 0;

  function add_timeouts(chain) {
    for (const a of chain.attempts) {
      if (a.outcome !== 'client_closed') continue;
      const key = a.fault_id ?? 'none';
      if (!timeouts.has(key)) timeouts.set(key, []);
      timeouts.get(key).push(a.total_ms);
    }
  }

  function add_backoff(chain) {
    for (let i = 0; i + 1 < chain.attempts.length; i += 1) {
      const a = chain.attempts[i];
      if (a.cls !== 'failure') continue;
      const gap = chain.attempts[i + 1].t - (a.t + a.total_ms);
      if (gap < 0) continue;
      backoff.all.push(gap);
      if (a.retry_after_s !== null) continue;
      backoff.self_chosen.push(gap);
      if (!backoff.by_step.has(i + 1)) backoff.by_step.set(i + 1, []);
      backoff.by_step.get(i + 1).push(gap);
    }
    const gaps = gaps_without_retry_after(chain);
    if (!gaps.length) return;
    backoff.measured_chains += 1;
    if (!is_hammering(gaps)) return;
    backoff.hammering += 1;
    if (backoff.examples.size < EXAMPLE_LIMIT) backoff.examples.add(chain.shape_key);
  }

  function add_shape(chain) {
    let s = shapes.get(chain.shape_key);
    if (!s)
      shapes.set(
        chain.shape_key,
        (s = {
          shape: chain.shape_key,
          service: chain.service,
          recovered: 0,
          unrecovered: 0,
          not_retried: 0,
          labels: new Map(),
        }),
      );
    s[chain.result] += 1;
    if (chain.result !== 'recovered') bump(s.labels, chain.origin.label);
  }

  function add(chain) {
    total += 1;
    let o = origins.get(chain.origin.label);
    if (!o) origins.set(chain.origin.label, (o = create_origin(chain)));
    o.chains += 1;
    o[chain.result] += 1;
    if (chain.attempt_count > 1 && chain.counted) o.counted += 1;
    if (chain.result === 'recovered') {
      o.attempts_to_clean.push(chain.attempt_count);
      o.recover_ms.push(chain.recovered_t - chain.start_t);
    }
    add_timeouts(chain);
    add_backoff(chain);
    add_shape(chain);
    if (details.length < CHAIN_DETAIL_LIMIT) details.push(chain);
  }

  function finish() {
    return {
      total,
      by_origin: [...origins.values()]
        .map(origin_to_json)
        .sort((a, b) => Number(b.injected) - Number(a.injected) || b.chains - a.chains),
      by_shape: [...shapes.values()]
        .filter((s) => s.unrecovered || s.not_retried)
        .map((s) => ({ ...s, labels: ranked_counts(s.labels) }))
        .sort((a, b) => b.unrecovered + b.not_retried - (a.unrecovered + a.not_retried)),
      timeouts: [...timeouts.entries()].map(([fault_id, waits]) => ({
        fault_id,
        waits_ms: summarise_list(waits),
      })),
      backoff: {
        all_ms: summarise_list(backoff.all),
        self_chosen_ms: summarise_list(backoff.self_chosen),
        by_step: [...backoff.by_step.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([step, gaps]) => ({
            after_failure: step,
            count: gaps.length,
            median_ms: median(gaps),
          })),
        chains_measured_without_retry_after: backoff.measured_chains,
        hammering_chains: backoff.hammering,
        hammering_examples: [...backoff.examples],
        immediate_retry_ms: IMMEDIATE_RETRY_MS,
        fast_retry_ms: FAST_RETRY_MS,
      },
      detail: details,
      detail_limit: CHAIN_DETAIL_LIMIT,
    };
  }

  return { add, finish };
}
