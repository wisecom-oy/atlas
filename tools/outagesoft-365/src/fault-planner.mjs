/**
 * Decides which fault, if any, a request receives. Pure: no I/O, no clock.
 *
 * Inputs are the request's facts, the time since the first relayed request,
 * the effective plan (rates after intensity and filters, parameter overrides,
 * outage windows), and the request's own generator. The output is a decision
 * with every parameter already drawn, so execution needs no further choices
 * from the planner and the journal records exactly what was applied.
 *
 * Precedence: replay schedule (when replaying, nothing else applies), then a
 * forced fault (selfcheck only), then an active outage, then the profile draw.
 */
import { FAULT_IDS, WAIT_PARAMS, fault_applies, get_fault } from './fault-catalog.mjs';
import { active_outage, identity_outage_fault } from './outage-schedule.mjs';
import { draw_sub_seed } from './seeded-random.mjs';

/** Draws one parameter value from a spec: a number, an [min, max] range, or { choice }. */
function draw_param(spec, rng) {
  if (typeof spec === 'number') return spec;
  if (Array.isArray(spec)) {
    const [min, max] = spec;
    if (Number.isInteger(min) && Number.isInteger(max)) return rng.int(min, max);
    return Math.round(rng.float(min, max) * 1000) / 1000;
  }
  return rng.pick(spec.choice);
}

/** Caps every wait parameter at `max_hold_ms`, so no single injected wait outlasts --max-hold. */
export function cap_waits(params, max_hold_ms) {
  const capped = { ...params };
  for (const name of Object.keys(capped)) {
    if (WAIT_PARAMS.has(name) && typeof capped[name] === 'number') {
      capped[name] = Math.min(capped[name], max_hold_ms);
    }
  }
  return capped;
}

/** Draws the full parameter set for a fault: catalog defaults, profile overrides, a sub-seed. */
export function draw_fault_params(fault_id, overrides, rng, max_hold_ms) {
  const fault = get_fault(fault_id);
  const specs = { ...fault.params, ...(overrides?.[fault_id] ?? {}) };
  const params = {};
  for (const name of Object.keys(specs)) params[name] = draw_param(specs[name], rng);
  // Execution-time choices (which items to duplicate, request ids in error bodies)
  // derive from this, so a replay reproduces them from the journal alone.
  params.sub_seed = draw_sub_seed(rng);
  return cap_waits(params, max_hold_ms);
}

/** Picks a fault from the profile rates with one draw, or null; only faults that apply are eligible. */
function draw_profile_fault(request, rates, u) {
  let cumulative = 0;
  for (const id of FAULT_IDS) {
    const rate = rates[id];
    if (!rate || !fault_applies(get_fault(id), request)) continue;
    cumulative += rate;
    if (u < cumulative) return id;
  }
  return null;
}

/**
 * Plans the fault for one request.
 *
 * `plan`: { rates, params, outages, services_filter, max_hold_ms, replay }.
 * `replay_entry`: the scheduled { id, params } for this request when replaying.
 */
export function plan_fault({ request, elapsed_ms, plan, rng, forced_id, replay_entry }) {
  if (plan.replay) {
    if (!replay_entry) return null;
    return {
      id: replay_entry.id,
      source: 'replay',
      params: cap_waits(replay_entry.params, plan.max_hold_ms),
    };
  }

  // Drawn first and unconditionally, so the parameter draws that follow come
  // from the same position in the stream whichever branch is taken.
  const u = rng.next();

  if (forced_id) {
    const params = draw_fault_params(forced_id, plan.params, rng, plan.max_hold_ms);
    return { id: forced_id, source: 'profile', params, forced: true };
  }

  const outage = active_outage(plan.outages, elapsed_ms, request.service);
  if (outage) {
    const id = request.service === 'identity' ? identity_outage_fault(outage.fault) : outage.fault;
    return {
      id,
      source: 'outage',
      params: draw_fault_params(id, plan.params, rng, plan.max_hold_ms),
    };
  }

  if (plan.services_filter && !plan.services_filter.includes(request.service)) return null;
  const id = draw_profile_fault(request, plan.rates, u);
  if (!id) return null;
  return {
    id,
    source: 'profile',
    params: draw_fault_params(id, plan.params, rng, plan.max_hold_ms),
  };
}
