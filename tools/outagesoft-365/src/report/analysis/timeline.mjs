/**
 * Requests, injected faults and outage windows in fixed time buckets.
 *
 * The bucket width is picked from a fixed ladder so a run of any length fits in about forty rows,
 * which keeps an outage window visible as a block of rows rather than a single averaged figure.
 * Time zero is the first relayed request, the same origin outage `start` values use.
 */
import { classify_attempt } from './fault-knowledge.mjs';
import { fault_applied } from './traffic-aggregates.mjs';

const BUCKET_LADDER_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const TARGET_BUCKETS = 40;

/** Smallest ladder width that covers `span_ms` in at most forty buckets. */
export function choose_bucket_ms(span_ms) {
  for (const s of BUCKET_LADDER_S) {
    if (span_ms / (s * 1000) <= TARGET_BUCKETS) return s * 1000;
  }
  return BUCKET_LADDER_S[BUCKET_LADDER_S.length - 1] * 1000;
}

/** Creates the timeline accumulator over `[base_t, base_t + span_ms]`. */
export function create_timeline(base_t, span_ms, windows) {
  const bucket_ms = choose_bucket_ms(span_ms);
  const count = Math.max(1, Math.ceil((span_ms + 1) / bucket_ms));
  const buckets = Array.from({ length: count }, (_, i) => ({
    start_ms: i * bucket_ms,
    requests: 0,
    faults: 0,
    outage_faults: 0,
    failures: 0,
    outages: windows
      .filter((w) => w.start_t < base_t + (i + 1) * bucket_ms && w.end_t > base_t + i * bucket_ms)
      .map((w) => w.service),
  }));

  function add(a) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((a.t - base_t) / bucket_ms)));
    const b = buckets[index];
    b.requests += 1;
    if (fault_applied(a)) b.faults += 1;
    if (fault_applied(a) && a.fault_source === 'outage') b.outage_faults += 1;
    if (classify_attempt(a) === 'failure') b.failures += 1;
  }

  return { add, finish: () => ({ bucket_ms, buckets }) };
}
