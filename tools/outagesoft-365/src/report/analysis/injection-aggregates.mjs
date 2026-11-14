/**
 * What was injected: faults per id, category and service, skipped mutations, and outage spans.
 *
 * A fault that was planned but could not be applied (a mutation on a non-JSON or oversized body)
 * is counted as skipped with its reason and never as injected, because the client received the
 * real response. Outage spans are recorded from the journal so that an outage window can still be
 * shown when run.json does not describe it.
 */
import { fault_category } from './fault-knowledge.mjs';
import { delivered_status_key, fault_applied } from './traffic-aggregates.mjs';
import { bump, ranked_counts } from './number-summary.mjs';

function create_fault_entry(attempt) {
  return {
    fault_id: attempt.fault_id,
    category: fault_category(attempt.fault_id, attempt.fault_category),
    category_from_journal: Boolean(attempt.fault_category),
    applied: 0,
    skipped: 0,
    from_profile: 0,
    from_outage: 0,
    from_replay: 0,
    services: new Map(),
    delivered: new Map(),
  };
}

function add_outage_span(spans, a) {
  let span = spans.get(a.service);
  if (!span) {
    span = { service: a.service, count: 0, first_t: a.t, last_t: a.t, faults: new Map() };
    spans.set(a.service, span);
  }
  span.count += 1;
  span.first_t = Math.min(span.first_t, a.t);
  span.last_t = Math.max(span.last_t, a.t);
  bump(span.faults, a.fault_id);
}

function fault_to_json(entry) {
  return {
    fault_id: entry.fault_id,
    category: entry.category,
    category_source: entry.category_from_journal ? 'journal' : 'fallback table',
    applied: entry.applied,
    skipped: entry.skipped,
    from_profile: entry.from_profile,
    from_outage: entry.from_outage,
    from_replay: entry.from_replay,
    services: ranked_counts(entry.services),
    delivered_mix: ranked_counts(entry.delivered),
  };
}

/** Creates the accumulator for injected faults, skipped mutations and outage spans. */
export function create_injection_aggregates() {
  const faults = new Map();
  const categories = new Map();
  const services = new Map();
  const skipped = new Map();
  const outage_spans = new Map();
  let applied_total = 0;
  let skipped_total = 0;

  function add_applied(entry, a) {
    applied_total += 1;
    entry.applied += 1;
    // A replayed fault is reported as replayed whatever its source was in the original run; the
    // replay does not re-evaluate outage windows, so it must not invent one.
    if (a.fault_source === 'outage') entry.from_outage += 1;
    else if (a.fault_source === 'replay') entry.from_replay += 1;
    else entry.from_profile += 1;
    bump(entry.services, a.service);
    bump(entry.delivered, delivered_status_key(a));
    bump(categories, entry.category);
    bump(services, a.service);
    if (a.fault_source === 'outage') add_outage_span(outage_spans, a);
  }

  function add(a) {
    if (!a.fault_id) return;
    let entry = faults.get(a.fault_id);
    if (!entry) faults.set(a.fault_id, (entry = create_fault_entry(a)));
    if (fault_applied(a)) {
      add_applied(entry, a);
      return;
    }
    skipped_total += 1;
    entry.skipped += 1;
    bump(skipped, `${a.fault_id}\u0000${a.fault_skipped}`);
  }

  function finish() {
    return {
      applied_total,
      skipped_total,
      by_fault: [...faults.values()]
        .map(fault_to_json)
        .sort((a, b) => b.applied - a.applied || b.skipped - a.skipped),
      by_category: ranked_counts(categories),
      by_service: ranked_counts(services),
      skipped: ranked_counts(skipped).map(({ key, count }) => {
        const [fault_id, reason] = key.split('\u0000');
        return { fault_id, reason, count };
      }),
      outage_spans: [...outage_spans.values()].map((s) => ({
        ...s,
        faults: ranked_counts(s.faults),
      })),
    };
  }

  return { add, finish };
}
