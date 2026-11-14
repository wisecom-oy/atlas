/**
 * Builders for synthetic run directories used by the report self-check.
 *
 * Records follow the run directory contract in the spec exactly, so the self-check exercises the
 * same reader the real journal goes through. Example values use `user@example.com` and `contoso`
 * only, already templated the way the relay writes them.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { write_report } from './write-report.mjs';

export const MAIL_URL = 'graph.microsoft.com/v1.0/users/{upn}/messages/{id}';
export const DRIVE_URL = 'graph.microsoft.com/v1.0/drives/{id}/items/{id}/content';
export const DELTA_URL =
  'graph.microsoft.com/v1.0/users/{upn}/mailFolders/{id}/messages/delta?$deltatoken=<1840b>';
export const SEND_URL = 'graph.microsoft.com/v1.0/users/{upn}/sendMail';

let next_seq = 1;

/** A run.json object with sensible defaults for a finished run. */
export function run_json(overrides = {}) {
  return {
    schema: 1,
    tool: 'outagesoft-365',
    started_at: '2026-11-14T08:00:00.000Z',
    finished_at: '2026-11-14T08:03:00.000Z',
    profile: { id: 'throttled', severity: 2, rates: { throttle_429: 0.1 }, params: {} },
    seed: '42',
    intensity: 1,
    outages: [],
    services_filter: null,
    faults_filter: null,
    upstream_override: true,
    command: { executable: '/opt/node-runtime/bin/node', arg_count: 3 },
    child: { exit_code: 0, signal: null, duration_ms: 180000 },
    node: 'v22.22.3',
    undici: '6.24.1',
    relayed_requests: null,
    first_request_at_ms: 0,
    replay: null,
    verify: null,
    ...overrides,
  };
}

function build_fault(fault, params) {
  if (!fault) return null;
  if (typeof fault === 'object') return fault;
  return { id: fault, source: 'profile', params };
}

/**
 * One journal record. `key` sets url_key and, unless `identity` is given, identity_key too.
 * Pass `identity: null` to omit identity_key, as an older engine would.
 */
export function rec(o) {
  const status = o.status === undefined ? 200 : o.status;
  const forwarded = o.forwarded ?? !o.fault;
  const record = {
    seq: next_seq++,
    t: o.t,
    method: o.method ?? 'GET',
    url: o.url ?? MAIL_URL,
    url_key: o.key ?? 'k1',
    service: o.service ?? 'outlook',
    kind: o.kind ?? 'read',
    req_bytes: o.req_bytes ?? 0,
    fault: build_fault(
      o.fault,
      o.params ?? (o.retry_after ? { retry_after_s: o.retry_after } : {}),
    ),
    forwarded,
    upstream: forwarded
      ? { status: o.upstream_status ?? status ?? 200, first_byte_ms: 10, total_ms: 15, bytes: 1024 }
      : null,
    delivered: {
      status,
      outcome: o.outcome ?? 'complete',
      bytes: o.bytes ?? 1024,
      total_ms: o.total ?? 20,
      ...(o.retry_after ? { retry_after_s: o.retry_after } : {}),
      ...(o.error ? { error: o.error } : {}),
    },
    ...(o.graph_error ? { graph_error: o.graph_error } : {}),
  };
  if (o.identity !== null) record.identity_key = o.identity ?? record.url_key;
  if (o.occurrence) record.occurrence = o.occurrence;
  if ('cursor' in o) record.cursor = o.cursor;
  if ('idempotent' in o) record.idempotent = o.idempotent;
  if ('body_key' in o) record.body_key = o.body_key;
  if ('page' in o) record.page = o.page;
  if ('base_key' in o) record.base_key = o.base_key;
  if (record.fault && o.category) record.fault.category = o.category;
  return record;
}

/** Creates a fresh temporary parent directory for one self-check run. */
export async function create_workspace() {
  return mkdtemp(join(tmpdir(), 'outagesoft-report-selfcheck-'));
}

/**
 * Writes a run directory. `lines` holds record objects or raw strings; `run` is the run.json
 * object, or a string written verbatim, or null to omit run.json entirely.
 */
export async function write_run_dir(workspace, name, { run = run_json(), lines = [] } = {}) {
  const dir = join(workspace, name);
  await mkdir(dir, { recursive: true });
  if (run !== null)
    await writeFile(join(dir, 'run.json'), typeof run === 'string' ? run : JSON.stringify(run));
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  await writeFile(join(dir, 'journal.jsonl'), body ? `${body}\n` : '');
  return dir;
}

/** Writes a run directory, builds its report, and returns the parsed report.json, report.md and summary. */
export async function report_for(workspace, name, options) {
  const dir = await write_run_dir(workspace, name, options);
  const { report_path, terminal_summary } = await write_report(dir);
  const model = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  const md = await readFile(report_path, 'utf8');
  return { dir, model, md, terminal: terminal_summary, report_path };
}

/** The verdict row with the given check number. */
export function verdict(model, number) {
  return model.verdicts.find((v) => v.number === number);
}

/** The retry-chain summary for one origin label. */
export function origin(model, label) {
  return model.response.chains.by_origin.find((o) => o.label === label);
}
