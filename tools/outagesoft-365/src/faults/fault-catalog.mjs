/**
 * The fault catalog: every fault the relay can inject, and where it applies.
 *
 * Entry shape:
 *   id          stable identifier used in profiles, --faults and the journal
 *   category    throttle | server | auth | consistency | transport | content | ordering
 *   forwards    whether the request reaches the upstream at all
 *   services    services the fault may hit (a fault never lands where it would be unrealistic)
 *   kinds       request kinds it is limited to, or null for any
 *   methods     HTTP methods it is limited to, or null for any
 *   excluded_kinds  request kinds it must never hit, or null
 *   params      default parameters: a number, an [min, max] range, or { choice: [...] }
 *   summary     what the client sees
 *   basis       the real-world behaviour it mirrors
 */
import { SYNTHETIC_FAULTS } from './fault-catalog-synthetic.mjs';

const API = ['outlook', 'onedrive', 'sharepoint', 'teams', 'directory'];
const GRAPH = [...API, 'transfer'];
const ALL = [...GRAPH, 'identity'];

/** Faults that forward the request and then disturb the response. */
const FORWARDED_FAULTS = [
  {
    id: 'slow_first_byte',
    category: 'transport',
    services: ALL,
    params: { delay_ms: [2000, 15000] },
    summary: 'forwards after a delay, so the first byte arrives late',
    basis: 'Cold mailbox caches and busy backends add seconds before Graph starts answering.',
  },
  {
    id: 'slow_body',
    category: 'transport',
    services: ALL,
    params: { bytes_per_second: [2048, 16384], max_ms: 60000 },
    summary: 'delivers the body at a few KiB/s for up to max_ms, then at full speed',
    basis: 'Congested paths and throttled download hosts trickle large bodies.',
  },
  {
    id: 'truncated_body',
    category: 'transport',
    services: ALL,
    params: { fraction: [0.1, 0.9] },
    summary: 'forwards headers and part of the body, then drops the connection',
    basis:
      'A connection lost mid-body leaves the client with a short read ("terminated" in undici).',
  },
  {
    id: 'lost_response',
    category: 'transport',
    services: ALL,
    // Never on downloads: the relay would pull a whole file only to throw it away.
    excluded_kinds: ['download'],
    summary: 'the upstream completes the request, the client gets a reset instead of the answer',
    basis: 'A connection that drops after the server committed a write makes a retry run it twice.',
  },
  {
    id: 'malformed_json',
    category: 'content',
    services: API,
    methods: ['GET'],
    params: { fraction: [0.05, 0.95] },
    summary: 'the JSON body is cut short, with a matching content-length',
    basis:
      'Gateways occasionally flush a partial body as if complete; the client fails to parse it.',
  },
  {
    id: 'empty_body_200',
    category: 'content',
    services: API,
    methods: ['GET'],
    summary: 'status and headers kept, body empty',
    basis: 'A backend that times out after the gateway committed a 200 yields an empty success.',
  },
  {
    id: 'duplicate_items',
    category: 'content',
    services: API,
    methods: ['GET'],
    params: { count: [1, 3] },
    summary: 'repeats 1 to 3 elements of the top-level value array',
    basis: 'Delta queries are documented to return the same item more than once.',
  },
  {
    id: 'shuffle_items',
    category: 'content',
    services: API,
    methods: ['GET'],
    summary: 'reorders the top-level value array',
    basis: 'Graph does not guarantee ordering without $orderby, and delta pages are unordered.',
  },
  {
    id: 'drop_next_link',
    category: 'content',
    services: API,
    methods: ['GET'],
    summary: 'removes @odata.nextLink from a page that has one (destructive by design)',
    basis: 'Paging bugs have ended collections early; a client cannot detect it without counting.',
  },
  {
    id: 'batch_inner_429',
    category: 'throttle',
    services: GRAPH,
    kinds: ['batch'],
    params: { retry_after_s: [5, 30] },
    summary: 'a 200 $batch whose sub-responses include 429s with Retry-After',
    basis: 'JSON batching evaluates each sub-request against throttling limits on its own.',
  },
  {
    id: 'out_of_order',
    category: 'ordering',
    services: GRAPH,
    params: { overtaken_by: 2, max_hold_ms: 3000 },
    summary: 'holds a finished response until later responses have overtaken it',
    basis:
      'Concurrent requests served by different backends complete in an order unrelated to issue order.',
  },
];

/** Every fault, synthetic first, in a stable order. */
export const FAULTS = [
  ...SYNTHETIC_FAULTS.map((f) => ({ ...f, forwards: false })),
  ...FORWARDED_FAULTS.map((f) => ({ ...f, forwards: true })),
].map((f) => ({ kinds: null, methods: null, excluded_kinds: null, params: {}, ...f }));

const BY_ID = new Map(FAULTS.map((f) => [f.id, f]));

/** Every valid fault id. */
export const FAULT_IDS = FAULTS.map((f) => f.id);

/** Looks up a fault entry by id, or undefined. */
export function get_fault(id) {
  return BY_ID.get(id);
}

/** True when the fault may be injected into a request with these facts. */
export function fault_applies(fault, { service, kind, method }) {
  if (!fault.services.includes(service)) return false;
  if (fault.kinds && !fault.kinds.includes(kind)) return false;
  if (fault.excluded_kinds?.includes(kind)) return false;
  if (fault.methods && !fault.methods.includes(String(method).toUpperCase())) return false;
  return true;
}

/** Parameter names whose values are waits, and so are capped by --max-hold. */
export const WAIT_PARAMS = new Set(['delay_ms', 'hold_ms', 'max_ms', 'max_hold_ms']);

/** Throws when `spec` is not a valid override for the default parameter `name` of `fault`. */
export function validate_param_override(fault, name, spec) {
  if (!(name in fault.params)) {
    const known = Object.keys(fault.params);
    throw new Error(
      `fault '${fault.id}' has no parameter '${name}'` +
        (known.length ? ` (it takes: ${known.join(', ')})` : ' (it takes none)'),
    );
  }
  const numbers = Array.isArray(spec) ? spec : (spec?.choice ?? [spec]);
  const shape_ok =
    typeof spec === 'number' ||
    (Array.isArray(spec) && spec.length === 2 && spec[0] <= spec[1]) ||
    (Array.isArray(spec?.choice) && spec.choice.length > 0);
  if (!shape_ok || !numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    throw new Error(
      `parameter '${fault.id}.${name}' must be a non-negative number, [min, max] or { "choice": [...] }`,
    );
  }
  if (name === 'fraction' && numbers.some((n) => n <= 0 || n >= 1)) {
    throw new Error(`parameter '${fault.id}.fraction' must lie strictly between 0 and 1`);
  }
}
