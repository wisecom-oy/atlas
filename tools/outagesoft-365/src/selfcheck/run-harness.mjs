/**
 * Drives the real `outagesoft-365 run` path for the selfcheck: spawns the CLI
 * as a separate process (so the preload, NODE_OPTIONS and exit-code handling
 * are all exercised for real) and reads back what it wrote.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

/** Spawns the CLI with `args` in `cwd`; resolves { code, stdout, stderr }. Async so the fake upstream can answer. */
export function run_cli(args, { cwd, env = {}, timeout_ms = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, OUTAGESOFT_TEST_FORCE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`outagesoft-365 ${args[0]} timed out after ${timeout_ms}ms\n${stderr}`));
    }, timeout_ms);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Reads a run directory: run.json, journal entries, and the raw text of both. */
export function read_run(run_dir) {
  const run_text = readFileSync(join(run_dir, 'run.json'), 'utf8');
  const journal_text = readFileSync(join(run_dir, 'journal.jsonl'), 'utf8');
  const lines = journal_text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    run: JSON.parse(run_text),
    run_text,
    journal_text,
    entries: lines.filter((line) => line.seq !== undefined),
    relay_errors: lines.filter((line) => line.seq === undefined),
  };
}

/** Writes a child script into the work directory and returns its path. */
export function write_script(work, name, source) {
  const path = join(work, name);
  writeFileSync(path, source);
  return path;
}

/** Writes a JSON profile into the work directory and returns its path. */
export function write_profile(work, name, profile) {
  return write_script(work, name, JSON.stringify(profile));
}

/** Reads the observations a child script wrote with `observe()`. */
export function read_observations(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
