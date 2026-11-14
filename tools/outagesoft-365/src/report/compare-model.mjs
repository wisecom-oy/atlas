/**
 * Compares two runs of the same workload by request identity: the "lost files" detector.
 *
 * The baseline is normally a passthrough run. Any identity the baseline fetched successfully that
 * the faulted run never fetched successfully is something the client should have read and did not,
 * whether because it gave up, skipped it, or never asked. Identities only work across runs made on
 * the same checkout (they are keyed with a local secret), so a comparison with no shared identity
 * at all is reported as suspicious rather than as total loss.
 *
 * Pure: identity accumulators are fed attempts, and the comparison works on their results. Memory
 * is one small entry per distinct identity in each run.
 */
import { classify_attempt } from './fault-knowledge.mjs';
import { bump, ranked_counts } from './number-summary.mjs';

export const COMPARE_SCHEMA = 1;
const MAX_PAGES_LISTED = 20;

/** True when an attempt fetched its resource successfully: complete 2xx with no content fault. */
export function is_successful_fetch(a) {
  return classify_attempt(a) === 'clean' && a.status >= 200 && a.status < 300;
}

/** Creates an accumulator of identities for one run. */
export function create_identity_census() {
  const identities = new Map();
  const services = new Map();
  let attempts = 0;
  let missing_identity = 0;

  function add(a) {
    attempts += 1;
    bump(services, a.service);
    if (!a.identity_key) {
      missing_identity += 1;
      return;
    }
    let entry = identities.get(a.identity_key);
    if (!entry) {
      entry = {
        shape: a.shape_key,
        method: a.method,
        service: a.service,
        page: a.page ?? null,
        attempts: 0,
        succeeded: false,
      };
      identities.set(a.identity_key, entry);
    }
    entry.attempts += 1;
    if (is_successful_fetch(a)) entry.succeeded = true;
  }

  return { add, finish: () => ({ identities, services, attempts, missing_identity }) };
}

/** Why two censuses cannot be compared, or null when they can. */
export function compare_refusal(baseline, run) {
  const problems = [];
  for (const [name, c] of [
    ['baseline', baseline],
    ['run', run],
  ]) {
    if (!c.journal_present) problems.push(`the ${name} has no journal.jsonl`);
    else if (!c.attempts) problems.push(`the ${name} journal holds no requests`);
    else if (c.missing_identity)
      problems.push(
        `${c.missing_identity} of ${c.attempts} requests in the ${name} journal have no identity_key (written by an engine older than replay support)`,
      );
  }
  return problems.length ? `Cannot compare these runs: ${problems.join('; ')}.` : null;
}

function group_rows(entries, field_counts) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.service}\u0000${e.shape}`;
    let g = groups.get(key);
    if (!g)
      groups.set(
        key,
        (g = {
          service: e.service,
          shape: e.shape,
          count: 0,
          pages: [],
          ...Object.fromEntries(field_counts.map((f) => [f, 0])),
        }),
      );
    g.count += 1;
    // Pages are distinct identities; listing which ones were lost shows where a listing was cut.
    if (e.page !== null && e.page !== undefined && g.pages.length < MAX_PAGES_LISTED)
      g.pages.push(e.page);
    for (const f of field_counts) if (e[f]) g[f] += 1;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape));
}

function volume(baseline, run) {
  const names = new Set([...baseline.services.keys(), ...run.services.keys()]);
  return {
    baseline_requests: baseline.attempts,
    run_requests: run.attempts,
    extra_requests: run.attempts - baseline.attempts,
    baseline_identities: baseline.identities.size,
    run_identities: run.identities.size,
    by_service: [...names].sort().map((service) => ({
      service,
      baseline: baseline.services.get(service) ?? 0,
      run: run.services.get(service) ?? 0,
    })),
  };
}

/** Compares a baseline census with a run census; both must have passed `compare_refusal`. */
export function compare_censuses(baseline, run) {
  const lost = [];
  let shared = 0;
  for (const [key, b] of baseline.identities) {
    const r = run.identities.get(key);
    if (r) shared += 1;
    if (!b.succeeded || b.method !== 'GET' || r?.succeeded) continue;
    lost.push({
      service: b.service,
      shape: b.shape,
      page: b.page,
      never_requested: !r,
      requested_never_succeeded: Boolean(r),
      run_attempts: r?.attempts ?? 0,
    });
  }
  const only_in_run = [];
  for (const [key, r] of run.identities) {
    if (!baseline.identities.has(key))
      only_in_run.push({
        service: r.service,
        shape: r.shape,
        page: r.page,
        succeeded: r.succeeded,
      });
  }
  return {
    compare_schema: COMPARE_SCHEMA,
    shared_identities: shared,
    keys_look_unrelated: shared === 0 && baseline.identities.size > 0 && run.identities.size > 0,
    lost: {
      total: lost.length,
      never_requested: lost.filter((l) => l.never_requested).length,
      requested_never_succeeded: lost.filter((l) => l.requested_never_succeeded).length,
      by_shape: group_rows(lost, ['never_requested', 'requested_never_succeeded']),
      by_service: ranked_counts(lost.reduce((m, l) => (bump(m, l.service), m), new Map())),
    },
    only_in_run: { total: only_in_run.length, by_shape: group_rows(only_in_run, ['succeeded']) },
    volume: volume(baseline, run),
  };
}
