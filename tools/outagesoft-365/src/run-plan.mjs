/**
 * Turns validated options into the effective fault plan and the settings
 * recorded in run.json.
 *
 * Rates are resolved once, up front: fault filters first, then intensity,
 * then a proportional clamp so the sum stays at or below 0.95. Recording the
 * effective rates (not the profile's nominal ones) means a report shows what
 * was actually in force.
 */
import { load_profile_file } from './profile-file.mjs';
import { get_profile, total_rate } from './profiles.mjs';
import { load_replay_source } from './replay-schedule.mjs';
import { random_seed } from './seeded-random.mjs';

const MAX_TOTAL_RATE = 0.95;

/** Applies --faults / --exclude-faults, intensity and the 0.95 clamp to a profile's rates. */
export function effective_rates(rates, { only_faults, exclude_faults, intensity }) {
  const out = {};
  for (const [id, rate] of Object.entries(rates)) {
    if (only_faults && !only_faults.includes(id)) continue;
    if (exclude_faults && exclude_faults.includes(id)) continue;
    if (rate * intensity > 0) out[id] = rate * intensity;
  }
  const total = total_rate(out);
  const scale = total > MAX_TOTAL_RATE ? MAX_TOTAL_RATE / total : 1;
  for (const id of Object.keys(out)) out[id] = Math.round(out[id] * scale * 1e6) / 1e6;
  return out;
}

/** Resolves the profile: built-in by id, or loaded from --profile-file. */
function resolve_profile(options) {
  if (options.profile_file) return load_profile_file(options.profile_file);
  return get_profile(options.profile);
}

/** The surviving fault ids after --faults / --exclude-faults, or null when neither was given. */
function faults_filter(rates, options) {
  if (!options.only_faults && !options.exclude_faults) return null;
  return Object.keys(rates);
}

/** Builds a fresh (non-replay) plan from options. */
function build_fresh_plan(options) {
  const profile = resolve_profile(options);
  const rates = effective_rates(profile.rates, options);
  const profile_outages = profile.outages.map((o) =>
    profile.outage_service_from_cli && options.service ? { ...o, service: options.service } : o,
  );
  const outages = [...profile_outages, ...options.outages];
  return {
    plan: {
      rates,
      params: profile.params,
      outages,
      services_filter: options.services_filter,
      max_hold_ms: options.max_hold_ms,
      replay: false,
    },
    settings: {
      profile: { id: profile.id, severity: profile.severity, rates, params: profile.params },
      seed: options.seed ?? random_seed(),
      intensity: options.intensity,
      outages,
      services_filter: options.services_filter,
      faults_filter: faults_filter(rates, options),
    },
    replay_source: null,
  };
}

/** Builds a replay plan: settings from the source run, faults only from its schedule. */
function build_replay_plan(options) {
  const source = load_replay_source(options.replay);
  const { run } = source;
  return {
    plan: {
      rates: {},
      params: run.profile?.params ?? {},
      outages: [],
      services_filter: null,
      max_hold_ms: options.max_hold_ms,
      replay: true,
    },
    settings: {
      profile: run.profile,
      seed: run.seed,
      intensity: run.intensity,
      // A replay evaluates no windows: outage-sourced faults arrive through the
      // schedule, so recording the source's windows here would claim an outage
      // this run never timed.
      outages: [],
      services_filter: run.services_filter ?? null,
      faults_filter: run.faults_filter ?? null,
    },
    replay_source: source,
  };
}

/** Builds the effective plan, the run.json settings and (for --replay) the replay source. */
export function build_run_plan(options) {
  return options.replay ? build_replay_plan(options) : build_fresh_plan(options);
}
