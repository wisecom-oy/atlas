/**
 * `outagesoft-365 selfcheck`: end-to-end verification. No network, no credentials.
 *
 * The engine checks drive the real `run` command against a local fake Graph
 * (`--upstream`), with child scripts that call the real Microsoft 365
 * hostnames so the preload's re-route is what gets them to the relay. Faults
 * are forced per request with a test-only header (OUTAGESOFT_TEST_FORCE=1),
 * and waits are kept short with --max-hold and a selfcheck profile, so the
 * whole run takes seconds. The report engineer's own checks run last.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run_report_selfcheck } from './report/report-selfcheck.mjs';
import { create_check_list } from './selfcheck/check-list.mjs';
import { start_fake_graph } from './selfcheck/fake-graph.mjs';
import { run_fault_journal_checks } from './selfcheck/fault-journal-checks.mjs';
import { run_fault_shape_checks } from './selfcheck/fault-shape-checks.mjs';
import { run_identity_checks } from './selfcheck/identity-checks.mjs';
import { run_process_checks } from './selfcheck/process-checks.mjs';
import { run_relay_error_check } from './selfcheck/relay-error-check.mjs';
import { run_replay_checks } from './selfcheck/replay-checks.mjs';
import { run_cli } from './selfcheck/run-harness.mjs';
import { run_safety_unit_checks } from './selfcheck/safety-unit-checks.mjs';
import { run_unit_checks } from './selfcheck/unit-checks.mjs';

/** Checks that bad input fails before anything is spawned or any run directory is made. */
async function check_validation_before_spawn(work, check) {
  await check('invalid input fails before the command is spawned', async () => {
    const marker = join(work, 'spawned.txt');
    const result = await run_cli(
      [
        'run',
        '--profile',
        'stormy',
        '--',
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
      ],
      { cwd: work },
    );
    assert.equal(result.code, 64);
    assert.match(result.stderr, /unknown profile 'stormy'/);
    assert.ok(!existsSync(marker), 'the command ran despite invalid options');
    assert.ok(
      !existsSync(join(work, '.outagesoft-365')),
      'a run directory was created for an invalid run',
    );
  });
}

/** Runs the engine checks, then the report checks; resolves the process exit code. */
export async function run_selfcheck() {
  const started = Date.now();
  const work = mkdtempSync(join(tmpdir(), 'outagesoft-365-selfcheck-'));
  const fake = await start_fake_graph();
  const { check, passed, failed } = create_check_list();
  try {
    console.log('engine');
    await run_unit_checks(check);
    await run_safety_unit_checks(check);
    await check_validation_before_spawn(work, check);
    const scenario = await run_fault_shape_checks({ work, fake, check });
    await run_fault_journal_checks({ work, fake, check, scenario });
    await run_identity_checks({ work, fake, check });
    await run_replay_checks({ work, fake, check });
    await run_relay_error_check({ work, fake, check });
    await run_process_checks({ work, check });
  } catch (error) {
    failed.push('scenario setup');
    console.log(`  FAIL  scenario setup\n        ${error?.stack ?? error}`);
  } finally {
    fake.close();
  }

  let report_checks = 0;
  console.log('report');
  try {
    report_checks = await run_report_selfcheck();
  } catch (error) {
    failed.push('report selfcheck');
    console.log(`  FAIL  report selfcheck\n        ${error?.message ?? error}`);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failed.length) {
    console.log(
      `\n${failed.length} failed, ${passed.length + report_checks} passed (${seconds}s); work dir kept at ${work}`,
    );
    return 1;
  }
  rmSync(work, { recursive: true, force: true });
  console.log(
    `\n${passed.length + report_checks} checks passed (${passed.length} engine, ${report_checks} report) in ${seconds}s`,
  );
  return 0;
}
