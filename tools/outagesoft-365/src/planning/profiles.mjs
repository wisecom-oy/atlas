/**
 * Predefined severity profiles.
 *
 * Rates are per eligible request: a 0.02 `delta_resync_410` only ever lands
 * on delta requests, so its share of all traffic is much smaller than 2 %.
 * The weights follow how often each condition is reported against Graph:
 * throttling and 503/504 are common, 410s, spurious 401s, lost responses and
 * HTML error pages occasional, long outages rare.
 */
import { FAULT_IDS } from '../faults/fault-catalog.mjs';

const FLAKY_RATES = {
  throttle_429: 0.015,
  unavailable_503: 0.005,
  gateway_timeout_504: 0.003,
  connection_reset: 0.003,
  slow_first_byte: 0.004,
};

/** Weighted rates for `chaos`: every fault, throttling and 5xx heavier than the rare ones. */
function chaos_rates() {
  const heavy = new Set([
    'throttle_429',
    'throttle_503',
    'unavailable_503',
    'gateway_timeout_504',
    'slow_first_byte',
    'connection_reset',
  ]);
  const light = new Set([
    'throttle_429_long_retry_after',
    'html_503',
    'lost_response',
    'drop_next_link',
    'spurious_401',
    'token_endpoint_429',
  ]);
  return Object.fromEntries(
    FAULT_IDS.map((id) => [id, heavy.has(id) ? 0.02 : light.has(id) ? 0.003 : 0.006]),
  );
}

/** The built-in profiles, mildest first. */
export const PROFILES = [
  {
    id: 'passthrough',
    severity: 0,
    summary: 'no faults; a baseline to compare other runs against',
    rates: {},
  },
  {
    id: 'flaky',
    severity: 1,
    summary: 'about 3 %: mostly 429s, a few 503/504s, resets and slow starts',
    rates: FLAKY_RATES,
  },
  {
    id: 'throttled',
    severity: 2,
    summary: 'about 15 % throttling: 429 with and without Retry-After, 503, batch inner 429s',
    rates: {
      throttle_429: 0.08,
      throttle_429_no_retry_after: 0.02,
      throttle_503: 0.03,
      throttle_429_long_retry_after: 0.003,
      batch_inner_429: 0.02,
    },
  },
  {
    id: 'degraded',
    severity: 3,
    summary: 'latency dominated: slow first bytes, slow bodies, 504s, hangs, reordering',
    rates: {
      slow_first_byte: 0.2,
      slow_body: 0.08,
      gateway_timeout_504: 0.04,
      no_response: 0.01,
      out_of_order: 0.05,
      server_500: 0.01,
      unavailable_503: 0.01,
    },
  },
  {
    id: 'lossy',
    severity: 3,
    summary: 'about 12 % transport loss: resets, truncated bodies, hangs, lost responses',
    rates: {
      connection_reset: 0.04,
      truncated_body: 0.035,
      no_response: 0.015,
      lost_response: 0.03,
    },
  },
  {
    id: 'inconsistent',
    severity: 3,
    summary: 'wrong answers: duplicates, reordering, bad JSON, expired delta state, spurious 4xx',
    rates: {
      duplicate_items: 0.03,
      shuffle_items: 0.03,
      out_of_order: 0.02,
      malformed_json: 0.01,
      empty_body_200: 0.01,
      drop_next_link: 0.01,
      delta_resync_410: 0.02,
      delta_token_expired: 0.01,
      transient_404: 0.01,
      spurious_401: 0.01,
      spurious_400: 0.005,
    },
  },
  {
    id: 'brownout',
    severity: 4,
    summary: 'about 30 % mixed server errors, throttling, HTML 503s, resets and slowness',
    rates: {
      throttle_429: 0.07,
      throttle_503: 0.04,
      unavailable_503: 0.04,
      server_500: 0.02,
      bad_gateway_502: 0.02,
      gateway_timeout_504: 0.02,
      html_503: 0.02,
      connection_reset: 0.02,
      slow_first_byte: 0.04,
      slow_body: 0.01,
    },
  },
  {
    id: 'outage',
    severity: 5,
    summary: 'flaky background plus a 60 s outage of --service (default graph) starting at 20 s',
    rates: FLAKY_RATES,
    outages: [
      { service: 'graph', start_ms: 20_000, duration_ms: 60_000, fault: 'unavailable_503' },
    ],
    outage_service_from_cli: true,
  },
  {
    id: 'chaos',
    severity: 5,
    // Computed, so the summary cannot drift from the rates when the catalog grows.
    summary: `every fault in the catalog at moderate rates, about ${Math.round(total_rate(chaos_rates()) * 100)} % in total`,
    rates: chaos_rates(),
  },
].map((p) => ({ params: {}, outages: [], ...p }));

/** Looks up a built-in profile by id, or undefined. */
export function get_profile(id) {
  return PROFILES.find((p) => p.id === id);
}

/** Sum of a rates object. */
export function total_rate(rates) {
  return Object.values(rates).reduce((sum, rate) => sum + rate, 0);
}
