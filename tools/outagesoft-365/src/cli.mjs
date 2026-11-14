/**
 * outagesoft-365: run a command against an unreliable Microsoft Graph.
 *
 * Command dispatch only; each command lives in its own module.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { render_faults_table, render_profiles_table } from './cli/catalog-tables.mjs';
import { parse_run_args } from './cli/cli-args.mjs';
import { run_doctor } from './cli/doctor.mjs';
import { write_compare } from './report/write-compare.mjs';
import { write_report } from './report/write-report.mjs';
import { run_command } from './run/run-command.mjs';
import { PREREAD_BODY_CAP_BYTES } from './request/request-facts.mjs';
import { newest_run_dir, tool_home } from './run/run-directory.mjs';
import { run_selfcheck } from './selfcheck/selfcheck.mjs';
import { as_usage_error, EXIT_INTERNAL, EXIT_USAGE, UsageError } from './shared/tool-errors.mjs';

const USAGE = `outagesoft-365: run a command against an unreliable Microsoft Graph

USAGE
  outagesoft-365 run [options] -- <command...>
  outagesoft-365 report [run-dir]           rebuild report.md / report.json (default: newest run)
  outagesoft-365 compare <baseline-run> <run>   identities fetched in the baseline but never in the run
  outagesoft-365 profiles                   list profiles with severity, summary and rates
  outagesoft-365 faults                     list the fault catalog with the real-world basis of each
  outagesoft-365 doctor                     check node, undici and that both re-routes work
  outagesoft-365 selfcheck                  end-to-end verification, no network or credentials

RUN OPTIONS
  --profile <id>             fault profile (default flaky)
  --profile-file <json>      custom profile, same shape as the built-ins
  --seed <n|string>          PRNG seed (default random; always printed and recorded)
  --intensity <x>            multiply every fault rate (default 1; total clamped to 95 %)
  --outage <svc:start:dur[:fault]>   repeatable, e.g. outlook:30s:2m:no_response
                             start is relative to the first relayed request; fault defaults to
                             unavailable_503 and must be a synthetic (not forwarded) fault
  --service <svc>            service for the outage profile's built-in window (default graph)
  --services <a,b>           random faults only for these services (outages unaffected)
  --faults <a,b>             restrict random faults to these ids
  --exclude-faults <a,b>     remove these ids
  --upstream <url>           forward everything to this base URL instead of the real hosts (testing)
  --max-hold <dur>           cap for any single injected wait (default 120s)
  --out <dir>                run directory (default <repo>/.outagesoft-365/<UTC timestamp>/)
  --replay <run-dir>         apply exactly the faults a previous run applied, to the same requests
                             (takes profile, seed and filters from that run; cannot be combined with them)
  --verify-cmd "<command>"   after the child exits, run this without the relay and record its exit code
  --quiet                    no per-request stderr lines

Services: outlook onedrive sharepoint teams directory identity transfer; selectors graph (all but
identity) and all. Durations take a unit: 1500ms, 30s, 2m.

--upstream takes https, or plain http to a loopback host only, and never credentials.
Runs and the identity key live in .outagesoft-365/ at the nearest ancestor with .git.

REQUEST IDENTITY
  Faults are keyed by request identity and attempt number, so --seed and --replay hit the same
  requests whatever the concurrency. JSON POST/PATCH/PUT bodies up to ${PREREAD_BODY_CAP_BYTES / 1024 / 1024} MiB are read before
  planning and their digest joins the identity; larger or chunked bodies stream and are
  identified by URL only. Pages carrying a delta or skip token are numbered per listing.

EXIT CODES
  run passes the command's exit code through unchanged (128 + signal number if it was killed,
  127 if it could not start). The tool's own errors: 64 for invalid usage or input, 70 for an
  internal failure.

The journal and reports never hold headers, bodies, raw URLs or the command's arguments.
Testing only: with OUTAGESOFT_TEST_FORCE=1 in the environment, the relay honours an
x-outagesoft-force: <fault id> request header. The selfcheck uses it; never set it otherwise.

EXAMPLE
  outagesoft-365 run --profile throttled --seed 42 -- node packages/cli/dist/cli.mjs outlook backup -m user@example.com
`;

/** Resolves a run directory argument, or the newest run when none is given. */
function resolve_run_dir(arg) {
  const dir = arg ? resolve(arg) : newest_run_dir();
  if (!dir) throw new UsageError(`no run found in ${tool_home()}; run one first`);
  if (!existsSync(resolve(dir, 'run.json'))) {
    throw new UsageError(`'${arg ?? dir}' is not a run directory (no run.json)`);
  }
  return dir;
}

/** Prints a report or compare summary to stdout. */
function print_summary({ terminal_summary }) {
  process.stdout.write(terminal_summary.replace(/\n?$/, '\n'));
  return 0;
}

/** Dispatches one command; resolves the process exit code. */
async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'run':
      return run_command(as_usage_error(() => parse_run_args(rest)));
    case 'report':
      if (rest.length > 1) throw new UsageError('report takes at most one run directory');
      return print_summary(await write_report(resolve_run_dir(rest[0])));
    case 'compare':
      if (rest.length !== 2) {
        throw new UsageError('compare takes two run directories: <baseline-run> <run>');
      }
      return print_summary(await write_compare(resolve_run_dir(rest[0]), resolve_run_dir(rest[1])));
    case 'profiles':
      console.log(render_profiles_table());
      return 0;
    case 'faults':
      console.log(render_faults_table());
      return 0;
    case 'doctor':
      return run_doctor();
    case 'selfcheck':
      return run_selfcheck();
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return 0;
    default:
      throw new UsageError(`unknown command '${command}'; run 'outagesoft-365 help'`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`outagesoft-365: ${error?.message ?? error}\n`);
  process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_INTERNAL;
}
