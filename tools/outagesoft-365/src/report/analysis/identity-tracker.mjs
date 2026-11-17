/**
 * Follows each request identity across the run, in arrival order, for the completeness verdicts.
 *
 * `url_key` changes when a delta or skip token changes; `identity_key` does not (the engine removes
 * volatile parameters before hashing). That makes identity the right key for three questions:
 * was finished work fetched again, did a faulted paged request resume from its own page or restart
 * the enumeration, and was a faulted request ever satisfied later. Journals written before
 * `identity_key` existed fall back to `url_key`, which the evidence then says. When the journal
 * records a request body digest, it is part of the key, so distinct writes to one URL stay apart.
 *
 * Memory: one entry per identity that completed cleanly (to recognise a repeat), plus one per
 * pending faulted request; both are reported as counts, never as raw keys.
 */
import { classify_attempt } from './fault-knowledge.mjs';
import { fault_applied } from './traffic-aggregates.mjs';
import { bump, ranked_counts } from './number-summary.mjs';

const EXAMPLE_LIMIT = 5;
const RESTART_DEMANDING_FAULTS = new Set(['delta_resync_410', 'delta_token_expired']);
const RESTART_DEMANDING_CODES = new Set(['resyncRequired', 'syncStateNotFound']);

/** True when the server (real or injected) told the client its cursor is no longer valid. */
export function demands_restart(a) {
  if (fault_applied(a) && RESTART_DEMANDING_FAULTS.has(a.fault_id)) return true;
  return a.status === 410 || RESTART_DEMANDING_CODES.has(a.graph_error);
}

function add_example(list, shape_key) {
  if (list.length < EXAMPLE_LIMIT && !list.includes(shape_key)) list.push(shape_key);
}

/** Shape, with the page ordinal when the journal records one, for verdict examples. */
export function page_label(a) {
  return a.page === null || a.page === undefined ? a.shape_key : `${a.shape_key} (page ${a.page})`;
}

function refetch_kind(kind) {
  return kind === 'download' || kind === 'delta' ? kind : 'read';
}

/** Creates the identity tracker; feed attempts in arrival order. */
export function create_identity_tracker() {
  const completed = new Set();
  const refetch = new Map();
  const cursor_pending = new Map();
  const resume = {
    faulted: 0,
    resumed_same_page: 0,
    restart_demanded: 0,
    restart_undemanded: 0,
    other_token_demanded: 0,
    other_token_undemanded: 0,
    abandoned: 0,
    examples: [],
  };
  const unsatisfied = new Map();
  let keyed_by_identity = 0;

  // Current journals put the page ordinal into identity_key, so identity alone separates pages.
  // Journals without `page` collapsed every page of a listing into one identity; for those a
  // paged request is keyed by its exact URL instead, or page two would read as a re-fetch of one.
  function track_refetch(a, identity, cls) {
    if (a.method !== 'GET') return;
    const key = a.cursor && a.page === undefined ? `page:${a.url_key}` : identity;
    if (completed.has(key)) {
      // Count a re-fetch once: its own retries are not further duplicates, so the identity is
      // forgotten until this re-fetch completes again.
      completed.delete(key);
      const kind = refetch_kind(a.kind);
      if (!refetch.has(kind)) refetch.set(kind, { kind, extra_fetches: 0, examples: [] });
      const entry = refetch.get(kind);
      entry.extra_fetches += 1;
      add_example(entry.examples, a.shape_key);
    }
    if (cls === 'clean' && !fault_applied(a)) completed.add(key);
  }

  function resolve_cursor(a, key) {
    const pending = cursor_pending.get(key);
    if (!pending) return;
    cursor_pending.delete(key);
    if (a.url_key === pending.url_key) {
      resume.resumed_same_page += 1;
      return;
    }
    const outcome = a.cursor === null ? 'restart' : 'other_token';
    resume[`${outcome}_${pending.demanded ? 'demanded' : 'undemanded'}`] += 1;
    if (!pending.demanded) add_example(resume.examples, pending.label);
  }

  // Pages of one listing are followed by `base_key`, the identity before the page ordinal was
  // added: a restart (cursor null, page one again) has a different identity_key than the faulted
  // page but the same base_key. Older journals fall back to identity_key, which then spans pages.
  function track_cursor(a, cls) {
    if (a.cursor === undefined) return;
    const listing = a.base_key ?? a.identity_key ?? a.url_key;
    resolve_cursor(a, listing);
    if (!a.cursor || !fault_applied(a) || cls !== 'failure') return;
    resume.faulted += 1;
    cursor_pending.set(listing, {
      url_key: a.url_key,
      label: page_label(a),
      demanded: demands_restart(a),
    });
  }

  function track_satisfaction(a, key, cls) {
    if (cls !== 'failure') {
      unsatisfied.delete(key);
      return;
    }
    if (fault_applied(a) && !unsatisfied.has(key)) {
      unsatisfied.set(key, { label: page_label(a), fault_id: a.fault_id, service: a.service });
    }
  }

  function add(a) {
    // Identity plus body digest, so a later different $batch does not "satisfy" a failed one.
    const key = a.identity_group;
    if (a.identity_key) keyed_by_identity += 1;
    const cls = classify_attempt(a);
    track_refetch(a, key, cls);
    track_cursor(a, cls);
    track_satisfaction(a, key, cls);
  }

  function finish() {
    resume.abandoned = cursor_pending.size;
    const faults = new Map();
    const examples = [];
    for (const u of unsatisfied.values()) {
      bump(faults, u.fault_id);
      add_example(examples, u.label);
    }
    return {
      keyed_by_identity,
      refetch: [...refetch.values()].sort((x, y) => y.extra_fetches - x.extra_fetches),
      resume,
      unsatisfied: { count: unsatisfied.size, by_fault: ranked_counts(faults), examples },
    };
  }

  return { add, finish };
}
