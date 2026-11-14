/**
 * Builds the fault schedule for `run --replay <run-dir>` from a finished run.
 *
 * The schedule maps (identity_key, occurrence) to the fault that attempt
 * received, including outage-sourced ones, so a replay hits the same attempts
 * of the same requests whatever the timing. Faults recorded as skipped had no
 * effect and are not scheduled. Every (identity_key, occurrence) pair of the
 * source is also kept, so a replay can tell a request it has never seen from
 * one that simply was not faulted.
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** Key of one attempt of one request identity. */
export function attempt_key(identity_key, occurrence) {
  return `${identity_key}#${occurrence}`;
}

/** Reads and parses a run's run.json, naming the directory in errors. */
function read_source_run(run_dir) {
  try {
    return JSON.parse(readFileSync(join(run_dir, 'run.json'), 'utf8'));
  } catch (error) {
    throw new Error(`--replay '${run_dir}': cannot read run.json (${error.code ?? error.message})`);
  }
}

/** Reads the journal lines that describe relayed requests. */
function read_source_entries(run_dir) {
  let text;
  try {
    text = readFileSync(join(run_dir, 'journal.jsonl'), 'utf8');
  } catch (error) {
    throw new Error(
      `--replay '${run_dir}': cannot read journal.jsonl (${error.code ?? error.message})`,
    );
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn last line from a killed run carries no usable decision
    }
    if (entry.seq === undefined) continue; // top-level relay_error lines
    if (!entry.identity_key || !entry.occurrence) {
      throw new Error(
        `--replay '${run_dir}': the journal has no identity keys; it predates replay support`,
      );
    }
    entries.push(entry);
  }
  return entries;
}

/** Loads a source run: its recorded settings, its fault schedule, and every attempt it saw. */
export function load_replay_source(run_dir) {
  const dir = resolve(run_dir);
  const run = read_source_run(dir);
  if (run.tool !== 'outagesoft-365')
    throw new Error(`--replay '${run_dir}' is not an outagesoft-365 run`);
  const schedule = new Map();
  const seen = new Set();
  for (const entry of read_source_entries(dir)) {
    const key = attempt_key(entry.identity_key, entry.occurrence);
    seen.add(key);
    if (entry.fault && !entry.fault.skipped) {
      schedule.set(key, { id: entry.fault.id, params: entry.fault.params ?? {} });
    }
  }
  return { name: basename(dir), run, schedule, seen };
}
