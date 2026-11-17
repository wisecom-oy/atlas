/**
 * Command-line parsing and validation. Pure: reads no files, spawns nothing.
 *
 * Everything is validated here, before `run` starts a relay or a child, so a
 * typo in a fault id fails in milliseconds with a message naming the value
 * instead of after a ten minute backup that silently injected nothing.
 */
import { parse_duration } from '../shared/duration.mjs';
import { FAULT_IDS } from '../faults/fault-catalog.mjs';
import { expand_service_selector } from '../request/m365-hosts.mjs';
import { parse_outage_spec } from '../planning/outage-schedule.mjs';
import { get_profile } from '../planning/profiles.mjs';

const VALUE_OPTIONS = new Set([
  'profile',
  'profile-file',
  'seed',
  'intensity',
  'outage',
  'service',
  'services',
  'faults',
  'exclude-faults',
  'upstream',
  'max-hold',
  'out',
  'replay',
  'verify-cmd',
]);
const FLAG_OPTIONS = new Set(['quiet']);

/** Options a replay takes from the source run, and so must not be given alongside it. */
const REPLAY_EXCLUSIVE = [
  'profile',
  'profile-file',
  'seed',
  'outage',
  'intensity',
  'service',
  'services',
  'faults',
  'exclude-faults',
];

const DEFAULT_MAX_HOLD_MS = 120_000;

/** Splits a comma list, rejecting empty entries. */
function split_list(option, text) {
  const items = String(text)
    .split(',')
    .map((s) => s.trim());
  if (items.some((s) => !s)) throw new Error(`--${option} '${text}' has an empty entry`);
  return items;
}

/** Validates a list of fault ids, naming the first unknown one. */
function parse_fault_list(option, text) {
  const ids = split_list(option, text);
  const unknown = ids.find((id) => !FAULT_IDS.includes(id));
  if (unknown)
    throw new Error(`--${option}: unknown fault '${unknown}' (see: outagesoft-365 faults)`);
  return ids;
}

/** Validates a service list (selectors allowed) and expands it to service names. */
function parse_service_list(text) {
  const names = split_list('services', text);
  const expanded = new Set();
  for (const name of names) {
    const services = expand_service_selector(name);
    if (!services) throw new Error(`--services: unknown service '${name}'`);
    services.forEach((s) => expanded.add(s));
  }
  return [...expanded];
}

/** True for hosts that never leave the machine: 127.0.0.0/8, ::1 and localhost. */
export function is_loopback_host(hostname) {
  const host = String(hostname).toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Validates --upstream: an https base URL, or http only to a loopback host,
 * with no query, fragment or credentials. Plain http elsewhere would put live
 * bearer tokens on the network in clear text. Credentials are never echoed.
 */
function parse_upstream(text) {
  const shown = /@/.test(text) ? '<value with credentials, not shown>' : `'${text}'`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`--upstream ${shown} is not a URL`);
  }
  if (url.username || url.password) throw new Error('--upstream must not contain credentials');
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error(`--upstream ${shown} must be an http(s) base URL without query or fragment`);
  }
  if (url.protocol === 'http:' && !is_loopback_host(url.hostname)) {
    throw new Error(
      `--upstream ${shown}: plain http is only allowed to a loopback host; use https`,
    );
  }
  return url.href.replace(/\/$/, '');
}

/** Collects raw `--name value` pairs up to `--`, rejecting unknown options. */
function collect_run_options(argv) {
  const raw = { outage: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') return { raw, command: argv.slice(i + 1) };
    if (!arg.startsWith('--')) throw new Error(`unexpected '${arg}' (put -- before the command)`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (FLAG_OPTIONS.has(name) && eq === -1) {
      raw[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name))
      throw new Error(`unknown option '--${name}' (see: outagesoft-365 help)`);
    const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new Error(`--${name} needs a value`);
    if (name === 'outage') raw.outage.push(value);
    else if (name in raw) throw new Error(`--${name} given twice`);
    else raw[name] = value;
  }
  return { raw, command: [] };
}

/** Rejects option combinations that cannot mean anything. */
function check_combinations(raw) {
  if (raw.replay) {
    const clash = REPLAY_EXCLUSIVE.find((name) =>
      name === 'outage' ? raw.outage.length : raw[name] !== undefined,
    );
    if (clash) throw new Error(`--replay takes its settings from the source run; drop --${clash}`);
  }
  if (raw.profile && raw['profile-file'])
    throw new Error('give --profile or --profile-file, not both');
  if (raw.service !== undefined && (raw.profile ?? 'flaky') !== 'outage') {
    throw new Error(
      '--service only sets the window of --profile outage; use --outage for other profiles',
    );
  }
}

/** Parses and validates `run` arguments into options plus the child command. */
export function parse_run_args(argv) {
  const { raw, command } = collect_run_options(argv);
  if (!command.length)
    throw new Error('no command given; use: outagesoft-365 run [options] -- <command...>');
  check_combinations(raw);

  if (raw.profile && !get_profile(raw.profile)) {
    throw new Error(`unknown profile '${raw.profile}' (see: outagesoft-365 profiles)`);
  }
  const intensity = raw.intensity === undefined ? 1 : Number(raw.intensity);
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 100) {
    throw new Error(`--intensity '${raw.intensity}' must be a number between 0 and 100`);
  }
  if (raw.service !== undefined && !expand_service_selector(raw.service)) {
    throw new Error(`--service: unknown service '${raw.service}'`);
  }
  if (raw.seed !== undefined && !/^[\w.-]{1,64}$/.test(raw.seed)) {
    throw new Error(`--seed '${raw.seed}' must be 1 to 64 letters, digits, '.', '_' or '-'`);
  }
  const max_hold_ms =
    raw['max-hold'] === undefined ? DEFAULT_MAX_HOLD_MS : parse_duration(raw['max-hold']);
  if (max_hold_ms <= 0) throw new Error('--max-hold must be greater than 0');

  return {
    command,
    options: {
      profile: raw.profile ?? (raw['profile-file'] || raw.replay ? null : 'flaky'),
      profile_file: raw['profile-file'] ?? null,
      seed: raw.seed ?? null,
      intensity,
      outages: raw.outage.map(parse_outage_spec),
      service: raw.service ?? null,
      services_filter: raw.services ? parse_service_list(raw.services) : null,
      only_faults: raw.faults ? parse_fault_list('faults', raw.faults) : null,
      exclude_faults: raw['exclude-faults']
        ? parse_fault_list('exclude-faults', raw['exclude-faults'])
        : null,
      upstream: raw.upstream ? parse_upstream(raw.upstream) : null,
      max_hold_ms,
      out: raw.out ?? null,
      quiet: Boolean(raw.quiet),
      replay: raw.replay ?? null,
      verify_cmd: raw['verify-cmd'] ?? null,
    },
  };
}
