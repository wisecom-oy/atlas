/**
 * End-to-end checks for outage windows, --verify-cmd, identity-keyed
 * determinism under concurrency, and exact replay with divergence counters.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { write_compare } from '../report/write-compare.mjs';
import { assert_clean } from './journal-assertions.mjs';
import {
  read_observations,
  read_run,
  run_cli,
  write_profile,
  write_script,
} from './run-harness.mjs';

/**
 * Sequential child for the outage window outlook:300ms:400ms. SKIP drops the
 * request that falls inside the window; EXTRA adds one the source never made.
 */
const OUTAGE_CHILD = `
import { writeFileSync } from 'node:fs';
const G = 'https://graph.microsoft.com/v1.0';
const obs = {};
const get = async (name, url) => { const res = await fetch(G + url); await res.text(); obs[name] = res.status; };
const t0 = Date.now();
const until = (ms) => new Promise((r) => setTimeout(r, Math.max(0, t0 + ms - Date.now())));
await get('outlook_before', '/users/user@example.com/messages?$top=1');
await get('directory_before', '/users?$top=1');
await until(450);
if (process.env.SKIP !== '1') await get('outlook_during', '/users/user@example.com/messages?$top=2');
await get('directory_during', '/users?$top=2');
if (process.env.EXTRA === '1') await get('extra', '/users?$top=3');
await until(900);
await get('outlook_after', '/users/user@example.com/messages?$top=1');
writeFileSync(process.env.OBS_FILE, JSON.stringify(obs));
`;

/** Verify command: exits 3 when it runs without the preload and relay env, 9 otherwise. */
const VERIFY_SCRIPT = `
const leaked = (process.env.NODE_OPTIONS ?? '').includes('preload.mjs') || process.env.OUTAGESOFT_RELAY;
process.exit(leaked ? 9 : 3);
`;

/** Concurrent child: 16 distinct GETs in ORDER, each retried once after an error status. */
const CONCURRENT_CHILD = `
const G = 'https://graph.microsoft.com/v1.0';
const ids = Array.from({ length: 16 }, (_, i) => i);
if (process.env.ORDER === 'reverse') ids.reverse();
await Promise.all(ids.map(async (i, position) => {
  await new Promise((r) => setTimeout(r, position * 3));
  const res = await fetch(G + '/users/u' + i + '/memberOf');
  await res.text();
  if (res.status >= 400) await (await fetch(G + '/users/u' + i + '/memberOf')).text();
}));
`;

/** Maps identity_key#occurrence to the fault decision, for comparing two runs. */
function decisions(entries) {
  return Object.fromEntries(
    entries.map((e) => [
      `${e.identity_key}#${e.occurrence}`,
      e.fault ? JSON.stringify([e.fault.id, e.fault.params]) : null,
    ]),
  );
}

/** Runs one CLI `run` and returns the run's files plus the child's observations. */
async function run_scenario({ work, fake, name, args, script, env = {} }) {
  const run_dir = join(work, name);
  const obs_file = join(work, `${name}.json`);
  const result = await run_cli(
    [
      'run',
      ...args,
      '--upstream',
      fake.base,
      '--quiet',
      '--out',
      run_dir,
      '--',
      process.execPath,
      script,
    ],
    {
      cwd: work,
      env: { OBS_FILE: obs_file, ...env },
    },
  );
  assert.equal(result.code, 0, `${name} failed:\n${result.stderr}`);
  let obs = null;
  try {
    obs = read_observations(obs_file);
  } catch {
    /* scenarios without observations */
  }
  return { run_dir, obs, ...read_run(run_dir) };
}

/** Runs the outage, verify, determinism and replay scenarios and registers their checks. */
export async function run_replay_checks({ work, fake, check }) {
  const outage_script = write_script(work, 'outage-child.mjs', OUTAGE_CHILD);
  const verify_script = write_script(work, 'verify.mjs', VERIFY_SCRIPT);

  const source = await run_scenario({
    work,
    fake,
    name: 'run-outage',
    script: outage_script,
    args: [
      '--profile',
      'passthrough',
      '--seed',
      'outage',
      '--outage',
      'outlook:300ms:400ms',
      '--verify-cmd',
      `"${process.execPath}" "${verify_script}"`,
    ],
  });
  await check('an outage hits only its service, only inside its window', () => {
    assert.deepEqual(source.obs, {
      outlook_before: 200,
      directory_before: 200,
      outlook_during: 503,
      directory_during: 200,
      outlook_after: 200,
    });
    const faulted = source.entries.filter((e) => e.fault);
    assert.equal(faulted.length, 1);
    assert.equal(faulted[0].fault.source, 'outage');
    assert.equal(faulted[0].fault.id, 'unavailable_503');
  });
  await check('--verify-cmd runs without the preload and its exit code is recorded', () => {
    assert.equal(source.run.verify?.exit_code, 3);
    assert.ok(Number.isInteger(source.run.verify.duration_ms));
    assert.ok(!source.run_text.includes('verify.mjs'), 'verify command arguments were recorded');
  });

  const replay = await run_scenario({
    work,
    fake,
    name: 'run-replay',
    script: outage_script,
    args: ['--replay', source.run_dir],
  });
  await check('--replay reproduces an outage-sourced fault with no outage configured', () => {
    assert.equal(replay.obs.outlook_during, 503);
    assert.equal(replay.obs.outlook_before, 200);
    assert.deepEqual(replay.run.outages, []);
    const faulted = replay.entries.filter((e) => e.fault);
    assert.equal(faulted.length, 1);
    assert.equal(faulted[0].fault.source, 'replay');
    assert.deepEqual(replay.run.replay, {
      of: 'run-outage',
      scheduled: 1,
      applied: 1,
      not_encountered: 0,
      unscheduled_requests: 0,
    });
  });

  const diverged = await run_scenario({
    work,
    fake,
    name: 'run-diverged',
    script: outage_script,
    args: ['--replay', source.run_dir],
    env: { SKIP: '1', EXTRA: '1' },
  });
  await check('replay divergence counters are right when the child skips a request', () => {
    assert.deepEqual(diverged.run.replay, {
      of: 'run-outage',
      scheduled: 1,
      applied: 0,
      not_encountered: 1,
      unscheduled_requests: 1,
    });
    assert.ok(diverged.entries.every((e) => e.fault === null));
  });

  await check('write_compare runs on real run directories and holds no secrets', async () => {
    const { terminal_summary } = await write_compare(diverged.run_dir, source.run_dir);
    assert.equal(typeof terminal_summary, 'string');
    const compare_json = readFileSync(join(source.run_dir, 'compare.json'), 'utf8');
    JSON.parse(compare_json);
    assert_clean(compare_json, 'compare.json');
    assert_clean(readFileSync(join(source.run_dir, 'compare.md'), 'utf8'), 'compare.md');
  });

  const concurrent_script = write_script(work, 'concurrent-child.mjs', CONCURRENT_CHILD);
  const profile = write_profile(work, 'determinism-profile.json', {
    id: 'determinism',
    severity: 2,
    rates: { throttle_429: 0.25, server_500: 0.25, transient_404: 0.2 },
  });
  const args = ['--profile-file', profile, '--seed', 'fixed-seed'];
  const forward = await run_scenario({
    work,
    fake,
    name: 'run-forward',
    script: concurrent_script,
    args,
    env: { ORDER: 'forward' },
  });
  const reverse = await run_scenario({
    work,
    fake,
    name: 'run-reverse',
    script: concurrent_script,
    args,
    env: { ORDER: 'reverse' },
  });
  await check(
    'the same seed gives identical faults per request identity whatever the arrival order',
    () => {
      const faulted = forward.entries.filter((e) => e.fault).length;
      assert.ok(faulted >= 3, `only ${faulted} faults; the check proves nothing`);
      assert.ok(
        forward.entries.some((e) => e.occurrence === 2),
        'no retry was faulted or retried',
      );
      assert.notDeepEqual(
        forward.entries.map((e) => e.identity_key),
        reverse.entries.map((e) => e.identity_key),
        'arrival order did not differ',
      );
      assert.deepEqual(decisions(forward.entries), decisions(reverse.entries));
    },
  );
}
