#!/usr/bin/env node
/**
 * Teams scale rig CLI: runs one scenario against the fake Graph server and the real Teams backup.
 * Usage: node tools/teams-scale-rig/src/cli.mjs <sync|kill-resume|throttle-isolation> [options]
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { run_sync } from './scenarios/sync.mjs';
import { run_kill_resume } from './scenarios/kill-resume.mjs';
import { run_throttle_isolation } from './scenarios/throttle-isolation.mjs';
import { format_checks, format_run } from './report.mjs';
import { parse_args, USAGE } from './cli-args.mjs';

const SCENARIOS = {
  sync: run_sync,
  'kill-resume': run_kill_resume,
  'throttle-isolation': run_throttle_isolation,
};

/** Prints a run: measured runs get the full table, the rest one line with their fields. */
function render_run(run) {
  if (run.server) return format_run(run.name, run);
  const { name, wall_ms, ...fields } = run;
  return `${name}: wall ${(wall_ms / 1000).toFixed(1)} s ${JSON.stringify(fields)}`;
}

async function main() {
  let args;
  try {
    args = parse_args(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  process.env.ATLAS_TEAMS_RIG_PASSPHRASE ??= crypto.randomBytes(24).toString('hex');
  const store = args.store ?? path.join(os.tmpdir(), `atlas-teams-rig-${args.seed}`);
  const result = await SCENARIOS[args.scenario]({
    args,
    store,
    passphrase: process.env.ATLAS_TEAMS_RIG_PASSPHRASE,
  });
  const lines = [...result.runs.map(render_run), '', format_checks(result.checks)];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (args.json) process.stdout.write(`${JSON.stringify(result, replacer)}\n`);
  process.exitCode = result.checks.every((c) => c.ok) ? 0 : 1;
}

/** JSON replacer for Maps in request counters. */
function replacer(_key, value) {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exitCode = 1;
    // Exit now: a failed run can leave the server, samplers, or a backup still holding handles.
    process.exit(1);
  });
}
