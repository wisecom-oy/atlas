/**
 * Normalises `run.json` into the run header the report prints.
 *
 * `run.json` is written at start and rewritten at the end, so a killed run leaves the start
 * version behind: `finished_at` and `child` are null and the request counters are stale. A missing
 * or corrupt file must not stop the report either, because the journal alone still answers most
 * questions. Every field therefore has a defined absent value, and the gaps are listed as issues.
 */
import { basename } from 'node:path';
import { clean_identifier, clean_number, clean_text } from './journal-record.mjs';

function read_profile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const rates = {};
  for (const [id, rate] of Object.entries(p.rates && typeof p.rates === 'object' ? p.rates : {})) {
    const clean_id = clean_identifier(id);
    const clean_rate = clean_number(rate);
    if (clean_id && clean_rate !== null) rates[clean_id] = clean_rate;
  }
  return {
    id: clean_identifier(p.id) ?? 'unknown',
    severity: clean_number(p.severity),
    rates,
  };
}

function read_outages(outages) {
  if (!Array.isArray(outages)) return [];
  return outages
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({
      service: clean_identifier(o.service) ?? 'unknown',
      start_ms: clean_number(o.start_ms, 0),
      duration_ms: clean_number(o.duration_ms, 0),
      fault: clean_identifier(o.fault) ?? 'unavailable_503',
    }))
    .filter((o) => o.duration_ms > 0);
}

function read_child(child) {
  if (!child || typeof child !== 'object') return null;
  const exit_code = Number.isInteger(child.exit_code) ? child.exit_code : null;
  return {
    exit_code,
    signal: clean_identifier(child.signal),
    duration_ms: clean_number(child.duration_ms),
    // Set when the command could not be spawned (the engine exits 127); a short code such as ENOENT.
    error: clean_text(
      child.error === undefined || child.error === null ? null : String(child.error),
      60,
    ),
    interrupted: child.interrupted === true,
  };
}

function read_list(value) {
  if (!Array.isArray(value)) return null;
  return value.map(clean_identifier).filter(Boolean);
}

function read_iso_time(value) {
  const text = clean_text(value, 40);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function read_command(command) {
  if (!command || typeof command !== 'object') return null;
  // Only the executable's base name: a full path can carry a username, and the arguments are
  // deliberately absent from run.json because they carry mailbox addresses.
  const executable = clean_text(command.executable, 200);
  return {
    executable: executable ? clean_text(basename(executable.replaceAll('\\', '/')), 60) : null,
    arg_count: clean_number(command.arg_count),
  };
}

/**
 * `exited_zero`, `exited_nonzero` (including a signal), `failed_to_start`, or `unknown` when the
 * child result is absent.
 */
export function child_status(run) {
  if (!run.child) return 'unknown';
  if (run.child.error) return 'failed_to_start';
  if (run.child.signal || (run.child.exit_code !== null && run.child.exit_code !== 0))
    return 'exited_nonzero';
  return run.child.exit_code === 0 ? 'exited_zero' : 'unknown';
}

/** The run header used when run.json is missing or unreadable. */
export function empty_run_info() {
  return normalise_run_info({});
}

/** Converts a parsed run.json object into a fully defined run header. */
export function normalise_run_info(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const started_at = read_iso_time(r.started_at);
  const finished_at = read_iso_time(r.finished_at);
  const span = started_at && finished_at ? Date.parse(finished_at) - Date.parse(started_at) : null;
  return {
    schema: clean_number(r.schema),
    started_at,
    finished_at,
    duration_ms: span !== null && span >= 0 ? span : null,
    profile: read_profile(r.profile),
    seed: clean_text(r.seed === undefined || r.seed === null ? null : String(r.seed), 64),
    intensity: clean_number(r.intensity),
    outages: read_outages(r.outages),
    services_filter: read_list(r.services_filter),
    faults_filter: read_list(r.faults_filter),
    upstream_override: r.upstream_override === true,
    command: read_command(r.command),
    child: read_child(r.child),
    node: clean_text(r.node, 20),
    undici: clean_text(r.undici, 20),
    relayed_requests: clean_number(r.relayed_requests),
    first_request_at_ms: clean_number(r.first_request_at_ms),
    rejected_requests: clean_number(r.rejected_requests),
    relay_errors: clean_number(r.relay_errors),
    max_hold_ms: clean_number(r.max_hold_ms),
    replay: read_replay(r.replay),
    verify: read_verify(r.verify),
  };
}

function read_replay(replay) {
  if (!replay || typeof replay !== 'object') return null;
  return {
    // Only the source run directory's own name: a full path could carry a username.
    of: replay.of ? clean_text(basename(String(replay.of).replaceAll('\\', '/')), 80) : null,
    scheduled: clean_number(replay.scheduled),
    applied: clean_number(replay.applied),
    not_encountered: clean_number(replay.not_encountered),
    unscheduled_requests: clean_number(replay.unscheduled_requests),
  };
}

function read_verify(verify) {
  if (!verify || typeof verify !== 'object') return null;
  return {
    exit_code: Number.isInteger(verify.exit_code) ? verify.exit_code : null,
    duration_ms: clean_number(verify.duration_ms),
  };
}

/** Lists what is missing or unfinished in a run header, as short sentences for the report. */
export function describe_run_issues(run, present) {
  const issues = [];
  if (!present)
    return ['run.json is missing or unreadable, so the header comes from the journal alone.'];
  if (run.schema !== 1)
    issues.push(`run.json declares schema ${run.schema ?? 'none'}, this report reads schema 1.`);
  if (!run.finished_at || !run.child) {
    issues.push(
      'run.json was not finalised (no finish time or child result): the run was interrupted or the relay was killed.',
    );
  }
  return issues;
}
