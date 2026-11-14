/**
 * Checks on what the fault-shape run wrote: journal fields, the absence of
 * secrets in every output file, the report, and an exact replay of the run.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { write_report } from '../report/write-report.mjs';
import { CHILD_EXIT_CODE } from './fault-shapes-child.mjs';
import { assert_clean, entry_for } from './journal-assertions.mjs';
import { read_observations, read_run, run_cli } from './run-harness.mjs';

const HEX16 = /^[0-9a-f]{16}$/;

/** Registers the journal, report and replay checks for a finished fault-shape scenario. */
export async function run_fault_journal_checks({ work, fake, check, scenario }) {
  const { run, run_text, journal_text, entries, script, run_dir, obs } = scenario;
  const argument_needles = [script, 'fault-shapes-child'];

  await check('journal entries carry identity, occurrence, cursor and idempotency', () => {
    assert.equal(run.relayed_requests, entries.length);
    for (const e of entries) {
      assert.match(e.identity_key, HEX16);
      assert.match(e.url_key, HEX16);
      assert.ok(Number.isInteger(e.occurrence) && e.occurrence >= 1);
      assert.ok([null, 'delta', 'skip'].includes(e.cursor));
      assert.equal(typeof e.idempotent, 'boolean');
    }
    const templated = entries.some((e) => e.url.includes('/users/{upn}/messages/{id}'));
    assert.ok(templated, 'ids were not templated');
  });
  await check('journal carries fault.category, body_key and delivered.error', () => {
    assert.ok(entries.filter((e) => e.fault).every((e) => typeof e.fault.category === 'string'));
    assert.ok(entries.filter((e) => e.method === 'GET').every((e) => e.body_key === null));
    const send = entry_for(entries, '/sendMail');
    const batch = entries.find((e) => e.kind === 'batch');
    assert.match(send.body_key, HEX16);
    assert.match(batch.body_key, HEX16);
    assert.notEqual(send.body_key, batch.body_key);
    for (const fragment of ['reset-probe', 'hold-probe', '/sendMail']) {
      const error = entry_for(entries, fragment).delivered.error;
      assert.ok(error && error.length <= 120 && !/https?:|\//.test(error), `${fragment}: ${error}`);
    }
    const complete = entries.filter((e) => e.delivered.outcome === 'complete');
    assert.ok(complete.every((e) => e.delivered.error === undefined));
  });
  await check('journal and run.json hold no token, body, UPN or command argument', () => {
    assert_clean(journal_text, 'journal', argument_needles);
    assert_clean(run_text, 'run.json', argument_needles);
    assert_clean(scenario.stderr, 'stderr', argument_needles);
    assert.equal(run.command.arg_count, 1);
    assert.ok(!journal_text.toLowerCase().includes('authorization'));
  });
  await check('report.json and report.md are written and hold no secrets', async () => {
    await write_report(run_dir);
    const report_json = readFileSync(join(run_dir, 'report.json'), 'utf8');
    const report_md = readFileSync(join(run_dir, 'report.md'), 'utf8');
    JSON.parse(report_json);
    assert.ok(report_md.length > 0);
    assert_clean(report_json, 'report.json', argument_needles);
    assert_clean(report_md, 'report.md', argument_needles);
  });
  await check('--replay reproduces content faults exactly from the recorded params', async () => {
    const replay_dir = join(work, 'run-fault-shapes-replay');
    const replay_obs = join(work, 'fault-shapes-replay.json');
    const args = ['run', '--replay', run_dir, '--upstream', fake.base, '--max-hold', '400ms'];
    const replay = await run_cli(
      [...args, '--quiet', '--out', replay_dir, '--', process.execPath, script],
      {
        cwd: work,
        // Without the force header the replayed faults can only come from the schedule.
        env: { OBS_FILE: replay_obs, OUTAGESOFT_TEST_FORCE: '0' },
      },
    );
    assert.equal(replay.code, CHILD_EXIT_CODE, replay.stderr);
    const again = read_observations(replay_obs);
    assert.deepEqual(again.duplicates, obs.duplicates);
    assert.deepEqual(again.batch, obs.batch);
    assert.equal(again.throttle_outlook.retry_after, obs.throttle_outlook.retry_after);
    const request_id = (o) => o.throttle_outlook.body.error.innerError['request-id'];
    assert.equal(request_id(again), request_id(obs));
    const { run: replay_run } = read_run(replay_dir);
    assert.equal(replay_run.replay.applied, replay_run.replay.scheduled);
    assert.equal(replay_run.replay.unscheduled_requests, 0);
  });
}
