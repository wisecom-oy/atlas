/**
 * `outagesoft-365 run`: start the relay, run the command through it, then
 * finalise the journal, run.json and the report.
 *
 * The finalisation runs on every path: a clean exit, a failing child, a child
 * that never started, and an interrupted run. A failed backup is often the
 * very thing being investigated, so its journal and report matter most.
 */
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { exit_code_for, run_child_with_preload, run_verify_command } from './child-process.mjs';
import { load_or_create_identity_key } from './identity-key-store.mjs';
import { open_journal } from './journal.mjs';
import { start_relay } from './relay-server.mjs';
import { write_report } from './report/write-report.mjs';
import { check_out_dir, create_run_dir, tool_home, write_run_json } from './run-directory.mjs';
import { build_run_plan } from './run-plan.mjs';
import { as_usage_error } from './tool-errors.mjs';

/** Writes one tool message to stderr. */
function say(text) {
  process.stderr.write(`[outagesoft-365] ${text}\n`);
}

/** The initial run.json; the command's arguments are deliberately not recorded (they name mailboxes). */
function initial_run_record(settings, options, command) {
  return {
    schema: 1,
    tool: 'outagesoft-365',
    started_at: new Date().toISOString(),
    finished_at: null,
    ...settings,
    upstream_override: Boolean(options.upstream),
    command: { executable: basename(command[0]), arg_count: command.length - 1 },
    child: null,
    node: process.version,
    undici: process.versions.undici ?? null,
    relayed_requests: 0,
    first_request_at_ms: null,
    max_hold_ms: options.max_hold_ms,
    rejected_requests: 0,
    relay_errors: 0,
    replay: null,
    verify: null,
  };
}

/** Prints the run's opening line: what is being injected, and how to repeat it. */
function announce(run, run_dir, relay_url, options, replay_name) {
  const outages = run.outages
    .map((o) => `${o.service}@${o.start_ms}ms+${o.duration_ms}ms:${o.fault}`)
    .join(', ');
  const mode = replay_name
    ? `replay of ${replay_name} (profile ${run.profile?.id})`
    : `profile ${run.profile.id}`;
  say(
    `${mode}, seed ${run.seed}, intensity ${run.intensity}${outages ? `, outages ${outages}` : ''}`,
  );
  say(`relay ${relay_url}${options.upstream ? ` -> ${options.upstream}` : ''}, run dir ${run_dir}`);
}

/** Builds the report and prints its terminal summary; a report failure never changes the exit code. */
async function report_run(run_dir) {
  try {
    const { terminal_summary } = await write_report(run_dir);
    process.stderr.write(`${terminal_summary.replace(/\n?$/, '\n')}`);
  } catch (error) {
    say(
      `report failed: ${error?.message ?? error}; the journal is intact, retry with: outagesoft-365 report ${run_dir}`,
    );
  }
}

/** Runs `options` / `command` (already validated by cli-args) and resolves the exit code to use. */
export async function run_command({ options, command }) {
  // Everything that can fail on bad input happens before the relay starts or anything is
  // spawned, and is reported as a usage error (exit 64), not an internal failure (70).
  const { plan, settings, replay_source } = as_usage_error(() => {
    check_out_dir(options.out);
    return build_run_plan(options);
  });
  const identity_secret = load_or_create_identity_key(tool_home());
  const run_dir = create_run_dir(options.out);
  const token = randomBytes(24).toString('hex');
  const run = initial_run_record(settings, options, command);
  write_run_json(run_dir, run);

  const journal = open_journal(join(run_dir, 'journal.jsonl'));
  const relay = await start_relay({
    token,
    identity_secret,
    seed: settings.seed,
    plan,
    journal,
    upstream_base: options.upstream,
    quiet: options.quiet,
    allow_force: process.env.OUTAGESOFT_TEST_FORCE === '1',
    replay_source,
  });
  announce(run, run_dir, relay.url, options, replay_source?.name);

  let child;
  try {
    child = await run_child_with_preload(command, relay.url, token);
  } finally {
    await relay.close();
    journal.close();
  }

  run.child = { exit_code: child.exit_code, signal: child.signal, duration_ms: child.duration_ms };
  if (child.error) run.child.error = child.error;
  if (child.interrupted) run.child.interrupted = true;
  Object.assign(run, {
    finished_at: new Date().toISOString(),
    relayed_requests: relay.stats.relayed,
    first_request_at_ms: relay.stats.first_request_at_ms,
    rejected_requests: relay.stats.rejected,
    relay_errors: relay.stats.relay_errors,
    replay: relay.replay_stats(),
  });
  write_run_json(run_dir, run);

  if (options.verify_cmd && !child.interrupted) {
    say('running --verify-cmd without the relay');
    const verify = await run_verify_command(options.verify_cmd);
    run.verify = {
      exit_code: verify.exit_code ?? exit_code_for(verify),
      duration_ms: verify.duration_ms,
    };
    write_run_json(run_dir, run);
  } else if (options.verify_cmd) {
    say('run was interrupted; --verify-cmd skipped');
  }

  if (child.error) say(`command failed to start (${child.error})`);
  await report_run(run_dir);
  return exit_code_for(child);
}
