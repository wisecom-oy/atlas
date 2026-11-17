/**
 * Judges what the client did next after each failed or altered attempt on the same URL.
 *
 * Covers Retry-After compliance, re-sends while the previous exchange was still open, the
 * duplicate-write risk of re-sending a write that may already have run, and whether a damaged or
 * altered response was requested again. Every figure is inferred from the order of requests on a
 * URL; nothing here observes the client's intent.
 */
import {
  classify_attempt,
  fault_effect,
  is_content_fault,
  is_write_method,
} from './fault-knowledge.mjs';
import { fault_applied } from './traffic-aggregates.mjs';
import { summarise_list } from './number-summary.mjs';

/** A retry may arrive this much before the advised wait has elapsed and still count as honouring it. */
export const RETRY_AFTER_TOLERANCE_MS = 250;
const EXAMPLE_LIMIT = 5;
const DUPLICATE_LIST_LIMIT = 500;
const AMBIGUOUS_FAULTS = new Set([
  'lost_response',
  'no_response',
  'truncated_body',
  'gateway_timeout_504',
]);
const BODY_CORRUPTING_FAULTS = new Set(['malformed_json', 'empty_body_200', 'truncated_body']);

/** True when the client cannot know whether the request ran upstream. */
export function is_ambiguous_failure(a) {
  if (fault_applied(a) && AMBIGUOUS_FAULTS.has(a.fault_id)) return true;
  return a.outcome !== 'complete' && a.upstream_status !== null;
}

/** True when the relay actually delivered the request to the upstream and it answered. */
function reached_upstream(a) {
  return a.forwarded && a.upstream_status !== null;
}

/**
 * True when the request is, or may be, non-idempotent. The journal's `idempotent` field decides;
 * older journals lack it, and then POST and PATCH (the methods the engine marks non-idempotent) are
 * candidates whose idempotency the verdict reports as unknown.
 */
export function is_non_idempotent_candidate(a) {
  if (a.idempotent !== null) return a.idempotent === false;
  return a.method === 'POST' || a.method === 'PATCH';
}

function add_example(set, shape_key) {
  if (set.size < EXAMPLE_LIMIT) set.add(shape_key);
}

function tracks_content(a) {
  return (
    fault_applied(a) &&
    (is_content_fault(a.fault_id, a.fault_category) || BODY_CORRUPTING_FAULTS.has(a.fault_id))
  );
}

/** Creates the accumulator for next-attempt relations. */
export function create_relation_analysis() {
  const ra = {
    advised: 0,
    honoured: 0,
    early: 0,
    not_retried: 0,
    gaps: [],
    smallest: null,
    early_examples: new Set(),
    long_advised: 0,
  };
  const overlaps = new Map();
  const duplicates = { total: 0, list: [] };
  const safety = {
    ambiguous_writes: 0,
    resent_reached: 0,
    resent_not_reached: 0,
    not_resent: 0,
    unknown_idempotency: 0,
    resent_url_only: 0,
    examples: new Set(),
  };
  const content = new Map();

  function add_retry_after(r) {
    const advised_ms = r.from.retry_after_s * 1000;
    ra.advised += 1;
    if (r.from.retry_after_s > 300) ra.long_advised += 1;
    if (!r.next) {
      ra.not_retried += 1;
      return;
    }
    ra.gaps.push(r.gap_ms);
    if (!ra.smallest || r.gap_ms - advised_ms < ra.smallest.gap_ms - ra.smallest.advised_ms) {
      ra.smallest = { gap_ms: r.gap_ms, advised_ms, shape: r.from.shape_key };
    }
    if (r.gap_ms >= advised_ms - RETRY_AFTER_TOLERANCE_MS) {
      ra.honoured += 1;
    } else {
      ra.early += 1;
      add_example(ra.early_examples, r.from.shape_key);
    }
  }

  function add_overlap(r) {
    const key = fault_applied(r.from) ? r.from.fault_id : 'none';
    if (!overlaps.has(key)) overlaps.set(key, []);
    overlaps.get(key).push(r.next.t - r.from.t);
  }

  function add_retry_safety(r) {
    if (!is_non_idempotent_candidate(r.from)) return;
    if (r.from.idempotent === null) safety.unknown_idempotency += 1;
    safety.ambiguous_writes += 1;
    if (!r.next) {
      safety.not_resent += 1;
      return;
    }
    if (reached_upstream(r.from)) safety.resent_reached += 1;
    else safety.resent_not_reached += 1;
    // Without a body digest the re-send is matched by URL only and may be a different write.
    if (r.from.body_key === undefined) safety.resent_url_only += 1;
    add_example(safety.examples, r.from.shape_key);
  }

  function add_duplicate_risk(r) {
    if (!r.next || !is_write_method(r.from.method)) return;
    // A request the engine marks idempotent (a token request, an upload fragment) is safe to re-send.
    if (r.from.idempotent === true) return;
    duplicates.total += 1;
    if (duplicates.list.length >= DUPLICATE_LIST_LIMIT) return;
    duplicates.list.push({
      shape: r.from.shape_key,
      fault_id: fault_applied(r.from) ? r.from.fault_id : null,
      same_body: typeof r.from.body_key === 'string',
      upstream_status: r.from.upstream_status,
      reached_upstream: reached_upstream(r.from),
      idempotent: r.from.idempotent,
      resent_after_ms: r.next.t - r.from.t,
    });
  }

  function add_write_risk(r) {
    if (!is_ambiguous_failure(r.from)) return;
    add_retry_safety(r);
    add_duplicate_risk(r);
  }

  function add_content(r) {
    const id = r.from.fault_id;
    let c = content.get(id);
    if (!c)
      content.set(
        id,
        (c = {
          fault_id: id,
          effect: fault_effect(id),
          applied: 0,
          re_requested: 0,
          gaps: [],
          not_re_requested_shapes: new Set(),
        }),
      );
    c.applied += 1;
    if (r.next) {
      c.re_requested += 1;
      c.gaps.push(r.next.t - r.from.t);
    } else {
      add_example(c.not_re_requested_shapes, r.from.shape_key);
    }
  }

  function add(r) {
    const failed = classify_attempt(r.from) === 'failure';
    if (failed && r.from.retry_after_s !== null) add_retry_after(r);
    if (r.overlapped) add_overlap(r);
    if (failed) add_write_risk(r);
    if (tracks_content(r.from)) add_content(r);
  }

  function finish() {
    return {
      retry_after: {
        tolerance_ms: RETRY_AFTER_TOLERANCE_MS,
        advised: ra.advised,
        honoured: ra.honoured,
        early: ra.early,
        not_retried: ra.not_retried,
        long_advised_over_300s: ra.long_advised,
        gap_ms: summarise_list(ra.gaps),
        tightest: ra.smallest,
        early_examples: [...ra.early_examples],
      },
      overlaps: [...overlaps.entries()].map(([fault_id, offsets]) => ({
        fault_id,
        resent_after_ms: summarise_list(offsets),
      })),
      duplicates,
      retry_safety: { ...safety, examples: [...safety.examples] },
      content: [...content.values()].map((c) => ({
        fault_id: c.fault_id,
        effect: c.effect,
        applied: c.applied,
        re_requested: c.re_requested,
        not_re_requested: c.applied - c.re_requested,
        resent_after_ms: summarise_list(c.gaps),
        not_re_requested_shapes: [...c.not_re_requested_shapes],
      })),
    };
  }

  return { add, finish };
}
