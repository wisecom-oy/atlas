/**
 * The two passes over a journal that together produce every figure in the report.
 *
 * Pass one is order-independent: shapes, status mixes, latency, injected faults, graph-tap
 * figures, and the facts pass two needs (first arrival, longest exchange, outage spans). Pass two
 * replays the journal in arrival order through a bounded buffer for everything that depends on
 * sequence: retry chains, next-attempt relations, identities, the timeline and outage windows.
 * Two streaming passes keep memory independent of journal length; reading the file twice is the
 * price, and it is small next to the run that produced it.
 */
import { create_arrival_order_buffer } from './arrival-order-buffer.mjs';
import { create_chain_analysis } from './chain-analysis.mjs';
import { create_graph_tap_aggregates } from './graph-tap-aggregates.mjs';
import { create_identity_tracker } from './identity-tracker.mjs';
import { create_injection_aggregates } from './injection-aggregates.mjs';
import { create_window_accumulator, resolve_windows } from './outage-windows.mjs';
import { create_relation_analysis } from './relation-analysis.mjs';
import { create_chain_builder } from './retry-chains.mjs';
import { create_timeline } from './timeline.mjs';
import { create_traffic_aggregates } from './traffic-aggregates.mjs';

/** Creates the order-independent first pass. */
export function create_first_pass() {
  const traffic = create_traffic_aggregates();
  const injection = create_injection_aggregates();
  const graph_tap = create_graph_tap_aggregates();
  return {
    add(a) {
      traffic.add(a);
      injection.add(a);
      graph_tap.add(a);
    },
    finish: () => ({
      traffic: traffic.finish(),
      injection: injection.finish(),
      graph_tap: graph_tap.finish(),
    }),
  };
}

/** Time zero for the report: run.json's first request when recorded, else the earliest arrival. */
export function report_base_t(run, first) {
  return run.first_request_at_ms ?? first.traffic.totals.min_t ?? 0;
}

/** Creates the arrival-ordered second pass, configured from the first pass's results. */
export function create_second_pass(run, first) {
  const base_t = report_base_t(run, first);
  const totals = first.traffic.totals;
  const windows = resolve_windows(run, base_t, first.injection.outage_spans);
  const span_ms = Math.max(0, (totals.max_end ?? base_t) - base_t);
  const timeline = create_timeline(base_t, span_ms, windows);
  const window_acc = create_window_accumulator(windows);
  const chains = create_chain_analysis();
  const relations = create_relation_analysis();
  const identities = create_identity_tracker();
  const builder = create_chain_builder(
    (chain) => {
      chains.add(chain);
      window_acc.add_chain(chain);
    },
    (relation) => relations.add(relation),
  );
  const buffer = create_arrival_order_buffer(totals.max_total_ms, (a) => {
    timeline.add(a);
    window_acc.add(a);
    builder.add(a);
    identities.add(a);
  });

  return {
    add: (a) => buffer.push(a),
    finish() {
      const ordering = buffer.flush();
      builder.finish();
      return {
        base_t,
        ordering,
        timeline: timeline.finish(),
        windows: window_acc.finish(),
        chains: chains.finish(),
        relations: relations.finish(),
        identities: identities.finish(),
      };
    },
  };
}
