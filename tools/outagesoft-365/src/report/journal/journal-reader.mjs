/**
 * The report's only I/O on its inputs: reads `run.json` and streams `journal.jsonl`.
 *
 * A journal can hold hundreds of thousands of lines, so it is read line by line and each valid
 * record is handed to a callback; nothing here keeps the records. Lines that cannot be used are
 * counted by reason, and `{"relay_error": ...}` lines are counted with a few samples kept, because
 * a relay bug is itself a finding the report has to show rather than hide.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse_journal_line } from './journal-record.mjs';
import { describe_run_issues, empty_run_info, normalise_run_info } from './run-info.mjs';

const MAX_RUN_JSON_BYTES = 1_000_000;
const RELAY_ERROR_SAMPLES = 5;

/** Path of the journal inside a run directory. */
export function journal_path(run_dir) {
  return join(run_dir, 'journal.jsonl');
}

/** Reads and normalises run.json; never throws for a missing, oversized or corrupt file. */
export async function read_run_info(run_dir) {
  const path = join(run_dir, 'run.json');
  try {
    const info = await stat(path);
    if (info.size > MAX_RUN_JSON_BYTES) throw new Error('run.json too large');
    const run = normalise_run_info(JSON.parse(await readFile(path, 'utf8')));
    return { run, present: true, issues: describe_run_issues(run, true) };
  } catch {
    return { run: empty_run_info(), present: false, issues: describe_run_issues(null, false) };
  }
}

function create_reader_stats() {
  return {
    journal_present: true,
    lines: 0,
    blank: 0,
    attempts: 0,
    relay_errors: 0,
    relay_error_samples: [],
    malformed: 0,
    malformed_reasons: {},
    missing_url_key: 0,
    with_identity_key: 0,
    with_cursor: 0,
    with_idempotent: 0,
    with_base_key: 0,
    non_get: 0,
    non_get_with_body_key: 0,
  };
}

function count_line(stats, parsed) {
  stats.lines += 1;
  if (parsed.kind === 'blank') {
    stats.blank += 1;
  } else if (parsed.kind === 'relay_error') {
    stats.relay_errors += 1;
    if (stats.relay_error_samples.length < RELAY_ERROR_SAMPLES) {
      stats.relay_error_samples.push(parsed.message);
    }
  } else if (parsed.kind === 'malformed') {
    stats.malformed += 1;
    stats.malformed_reasons[parsed.reason] = (stats.malformed_reasons[parsed.reason] ?? 0) + 1;
  } else {
    const a = parsed.attempt;
    stats.attempts += 1;
    if (!a.has_url_key) stats.missing_url_key += 1;
    if (a.identity_key) stats.with_identity_key += 1;
    if (a.cursor !== undefined) stats.with_cursor += 1;
    if (a.idempotent !== null) stats.with_idempotent += 1;
    if (a.base_key) stats.with_base_key += 1;
    if (a.method !== 'GET') stats.non_get += 1;
    if (a.method !== 'GET' && a.body_key !== undefined) stats.non_get_with_body_key += 1;
  }
}

/**
 * Streams journal.jsonl, calling `on_attempt(attempt)` for every valid record in file order.
 * Returns line statistics; a missing journal yields zero attempts and `journal_present: false`.
 */
export async function stream_journal(path, on_attempt) {
  const stats = create_reader_stats();
  try {
    await stat(path);
  } catch {
    return { ...stats, journal_present: false };
  }
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    const parsed = parse_journal_line(line);
    count_line(stats, parsed);
    if (parsed.kind === 'attempt') on_attempt(parsed.attempt);
  }
  return stats;
}
