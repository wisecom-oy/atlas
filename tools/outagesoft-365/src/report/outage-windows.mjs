/**
 * Outage windows: what was requested during each one and how quickly the service recovered after.
 *
 * Windows come from run.json, where `start_ms` is relative to the first relayed request. When
 * run.json does not describe them (missing file, older engine) they are inferred from the span of
 * outage-sourced faults in the journal, and labelled as inferred. Recovery time is measured from the
 * end of the window to the completion of the first usable response for that service.
 */
import { classify_attempt } from './fault-knowledge.mjs';
import { fault_applied } from './traffic-aggregates.mjs';
import { summarise_list } from './number-summary.mjs';

const TOP_SHAPES = 5;

/** True when an outage selector (`graph`, `all` or a service name) covers a service. */
export function service_matches(selector, service) {
  if (selector === 'all') return true;
  if (selector === 'graph') return service !== 'identity';
  return selector === service;
}

/** Windows in relay time, from run.json or else inferred from outage-sourced journal records. */
export function resolve_windows(run, base_t, outage_spans) {
  if (run.outages.length) {
    return run.outages.map((o) => ({
      service: o.service,
      fault: o.fault,
      start_ms: o.start_ms,
      duration_ms: o.duration_ms,
      start_t: base_t + o.start_ms,
      end_t: base_t + o.start_ms + o.duration_ms,
      source: 'run.json',
    }));
  }
  return outage_spans.map((s) => ({
    service: s.service,
    fault: s.faults[0]?.key ?? 'unknown',
    start_ms: s.first_t - base_t,
    duration_ms: s.last_t - s.first_t + 1,
    start_t: s.first_t,
    end_t: s.last_t + 1,
    source: 'inferred from journal',
  }));
}

function create_window_state(w) {
  return {
    ...w,
    requests: 0,
    outage_faulted: 0,
    other_faulted: 0,
    failures: 0,
    urls: new Map(),
    other_services: { requests: 0, failures: 0 },
    first_attempt_after_ms: null,
    first_usable_after_ms: null,
    chains: { recovered: 0, unrecovered: 0, not_retried: 0, recovered_after_end_ms: [] },
  };
}

function add_inside(w, a) {
  w.requests += 1;
  if (fault_applied(a) && a.fault_source === 'outage') w.outage_faulted += 1;
  else if (fault_applied(a)) w.other_faulted += 1;
  if (classify_attempt(a) === 'failure') w.failures += 1;
  const url = w.urls.get(a.url_key) ?? { shape: a.shape_key, attempts: 0 };
  url.attempts += 1;
  w.urls.set(a.url_key, url);
}

function add_after(w, a) {
  const since = a.t - w.end_t;
  if (w.first_attempt_after_ms === null || since < w.first_attempt_after_ms)
    w.first_attempt_after_ms = since;
  if (classify_attempt(a) === 'failure') return;
  const done = a.t + a.total_ms - w.end_t;
  if (w.first_usable_after_ms === null || done < w.first_usable_after_ms)
    w.first_usable_after_ms = done;
}

/** Groups per-URL attempt counts by request shape, so templated ids do not repeat one row per item. */
function attempts_by_shape(urls) {
  const shapes = new Map();
  for (const u of urls.values()) {
    const s = shapes.get(u.shape) ?? { shape: u.shape, urls: 0, attempts: 0, max_per_url: 0 };
    s.urls += 1;
    s.attempts += u.attempts;
    s.max_per_url = Math.max(s.max_per_url, u.attempts);
    shapes.set(u.shape, s);
  }
  return [...shapes.values()].sort((x, y) => y.attempts - x.attempts).slice(0, TOP_SHAPES);
}

function window_to_json(w) {
  const counts = [...w.urls.values()].map((u) => u.attempts);
  const { urls, chains, ...rest } = w;
  return {
    ...rest,
    distinct_urls: urls.size,
    attempts_per_url: summarise_list(counts),
    most_attempted: attempts_by_shape(urls),
    chains: { ...chains, recovered_after_end_ms: summarise_list(chains.recovered_after_end_ms) },
  };
}

/** Creates the per-window accumulator; feed attempts and finished chains. */
export function create_window_accumulator(windows) {
  const states = windows.map(create_window_state);

  function add(a) {
    for (const w of states) {
      const matches = service_matches(w.service, a.service);
      const inside = a.t >= w.start_t && a.t < w.end_t;
      if (inside && matches) add_inside(w, a);
      else if (inside) {
        w.other_services.requests += 1;
        if (classify_attempt(a) === 'failure') w.other_services.failures += 1;
      } else if (matches && a.t >= w.end_t) add_after(w, a);
    }
  }

  function add_chain(chain) {
    for (const w of states) {
      // A chain counts for a window when any of its attempts fell inside it: a request first
      // throttled before the outage and retried through it is part of the outage's story.
      if (!service_matches(w.service, chain.service)) continue;
      if (chain.start_t >= w.end_t || chain.last_t < w.start_t) continue;
      w.chains[chain.result] += 1;
      if (chain.result === 'recovered')
        w.chains.recovered_after_end_ms.push(chain.recovered_t - w.end_t);
    }
  }

  return { add, add_chain, finish: () => states.map(window_to_json) };
}
