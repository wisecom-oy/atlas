/**
 * End-to-end checks of every fault's wire shape, through the real `run` path.
 *
 * One run, one child: each probe forces a fault and records what undici
 * really reported, so "connection_reset produces a transport error" is
 * asserted against the client's own exception, not against the relay's intent.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CHILD_EXIT_CODE, FAULT_SHAPES_CHILD, LONG_ID } from './fault-shapes-child.mjs';
import { entry_for } from './journal-assertions.mjs';
import {
  read_observations,
  read_run,
  run_cli,
  write_profile,
  write_script,
} from './run-harness.mjs';

const PROFILE = {
  id: 'selfcheck',
  severity: 0,
  rates: {},
  params: {
    slow_first_byte: { delay_ms: [150, 150] },
    no_response: { hold_ms: 60000 },
    out_of_order: { overtaken_by: 1, max_hold_ms: 2000 },
    truncated_body: { fraction: [0.5, 0.5] },
    slow_body: { bytes_per_second: [1000, 1000], max_ms: 5000 },
  },
};

/** Runs the fault-shape scenario, registers its wire-shape checks, and returns what it produced. */
export async function run_fault_shape_checks({ work, fake, check }) {
  const script = write_script(work, 'fault-shapes-child.mjs', FAULT_SHAPES_CHILD);
  const profile = write_profile(work, 'selfcheck-profile.json', PROFILE);
  const obs_file = join(work, 'fault-shapes.json');
  const run_dir = join(work, 'run-fault-shapes');
  const args = ['run', '--profile-file', profile, '--seed', 'shapes', '--upstream', fake.base];
  const result = await run_cli(
    [...args, '--max-hold', '400ms', '--out', run_dir, '--', process.execPath, script],
    { cwd: work, env: { OBS_FILE: obs_file } },
  );
  const obs = read_observations(obs_file);
  const files = read_run(run_dir);
  const { run, entries, relay_errors } = files;
  const seen_paths = fake.seen.map((s) => s.path);

  await check("the child's exit code is preserved", () =>
    assert.equal(result.code, CHILD_EXIT_CODE, result.stderr),
  );
  await check('fetch is re-routed and response.url is unchanged', () => {
    assert.equal(obs.plain.status, 200);
    assert.equal(
      obs.plain.url,
      `https://graph.microsoft.com/v1.0/users/user@example.com/messages/${LONG_ID}`,
    );
    const hit = fake.seen.find((s) => s.path.includes(LONG_ID));
    assert.ok(
      hit?.authorized,
      'the upstream did not receive the request with its Authorization header',
    );
  });
  await check('node:https identity calls are re-routed', () => {
    assert.equal(obs.identity.status, 200, JSON.stringify(obs.identity));
    assert.ok(
      seen_paths.some((p) => p.endsWith('/oauth2/v2.0/token')),
      'token request never reached the upstream',
    );
    const token_entry = entries.find((e) => e.service === 'identity');
    assert.equal(token_entry?.kind, 'token');
    assert.match(
      token_entry.url,
      /^login\.microsoftonline\.com\/\{tenant\}\/oauth2\/v2\.0\/token$/,
    );
    // The token body carries the client secret: no digest of it, and a re-send is no duplicate write.
    assert.equal(token_entry.body_key, null);
    assert.equal(token_entry.idempotent, true);
  });
  await check('a wrong relay token gets 404 and is not forwarded', () => {
    assert.equal(obs.wrong_token.status, 404);
    assert.ok(!seen_paths.some((p) => p.includes('wrong-token-probe')));
    assert.equal(run.rejected_requests, 1);
    assert.equal(relay_errors.length, 1);
  });
  await check('429 carries Retry-After and the service-specific code', () => {
    assert.equal(obs.throttle_outlook.status, 429);
    assert.match(String(obs.throttle_outlook.retry_after), /^\d+$/);
    assert.equal(obs.throttle_outlook.body.error.code, 'ApplicationThrottled');
    assert.match(obs.throttle_outlook.body.error.innerError['request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(obs.throttle_drive.body.error.code, 'activityLimitReached');
    assert.equal(obs.throttle_drive.body.error.innerError.code, 'throttledRequest');
    const entry = entries.find((e) => e.url.endsWith('/users/{upn}/messages'));
    assert.equal(entry.delivered.retry_after_s, Number(obs.throttle_outlook.retry_after));
    assert.equal(entry.graph_error, 'ApplicationThrottled');
  });
  await check('html_503 is an IIS HTML page without Retry-After', () => {
    assert.equal(obs.html_503.status, 503);
    assert.match(obs.html_503.type, /^text\/html/);
    assert.equal(obs.html_503.retry_after, null);
    assert.ok(obs.html_503.body.includes('The application request queue is full'));
  });
  await check('connection_reset is a client transport error and is not forwarded', () => {
    assert.ok(obs.reset.threw, 'fetch resolved despite the reset');
    assert.match(String(obs.reset.threw.cause), /ECONNRESET|UND_ERR_SOCKET/);
    const entry = entry_for(entries, 'reset-probe');
    assert.equal(entry.delivered.outcome, 'reset');
    assert.equal(entry.forwarded, false);
    assert.ok(!seen_paths.some((p) => p.includes('reset-probe')));
  });
  await check('no_response holds the connection for --max-hold, then drops it', () => {
    assert.ok(obs.no_response.threw, 'fetch resolved despite no response');
    assert.ok(
      obs.no_response.waited_ms >= 350 && obs.no_response.waited_ms < 5000,
      `waited ${obs.no_response.waited_ms}ms`,
    );
    const entry = entry_for(entries, 'hold-probe');
    assert.equal(entry.delivered.outcome, 'no_response');
    assert.equal(entry.fault.params.hold_ms, 400);
  });
  await check('truncated_body fails the client read (content-length and chunked)', () => {
    for (const probe of [obs.truncated, obs.truncated_chunked]) {
      assert.equal(probe.status, 200);
      assert.ok(probe.read_error, `body read completed: ${JSON.stringify(probe)}`);
    }
    const truncated = entries.filter((e) => e.url.includes('truncate-probe'));
    assert.ok(
      truncated.every(
        (e) => e.delivered.outcome === 'truncated' && e.delivered.bytes < e.upstream.bytes,
      ),
    );
  });
  await check('malformed_json fails JSON parsing, not the transport', () => {
    assert.equal(obs.malformed.status, 200);
    assert.equal(obs.malformed.parse_error, 'SyntaxError');
  });
  await check('duplicate_items repeats items (gzip decoded, sent identity)', () => {
    assert.ok(
      obs.duplicates.count >= 4 && obs.duplicates.count <= 6,
      `count ${obs.duplicates.count}`,
    );
    assert.equal(obs.duplicates.encoding, null);
  });
  await check('drop_next_link removes only @odata.nextLink', () => {
    assert.equal(obs.next_link.has_next, false);
    assert.equal(obs.next_link.count, 3);
  });
  await check('batch_inner_429 throttles sub-responses with Retry-After', () => {
    assert.equal(obs.batch.status, 200);
    const throttled = obs.batch.inner.filter((r) => r.status === 429);
    assert.ok(throttled.length >= 1 && throttled.every((r) => /^\d+$/.test(r.retry_after)));
  });
  await check('out_of_order lets a later response overtake an earlier one', () => {
    assert.deepEqual(obs.out_of_order.order, ['b', 'a']);
  });
  await check('lost_response reaches the upstream, the client gets a reset', () => {
    assert.ok(obs.lost_response.threw, 'fetch resolved despite the lost response');
    const hit = fake.seen.find((s) => s.method === 'POST' && s.path.endsWith('/sendMail'));
    assert.ok(hit && hit.body_bytes > 0, 'the write never reached the upstream');
    const entry = entry_for(entries, '/sendMail');
    assert.equal(entry.forwarded, true);
    assert.equal(entry.upstream.status, 200);
    assert.equal(entry.delivered.outcome, 'reset');
    assert.equal(entry.idempotent, false);
  });
  await check('slow_first_byte delays the response', () =>
    assert.ok(obs.slow_first_byte.elapsed_ms >= 140),
  );
  await check('slow_body trickles the complete body', () => {
    // About 300 bytes at 100 bytes per 100 ms tick: at least two ticks of waiting.
    assert.equal(obs.slow_body.status, 200);
    assert.ok(obs.slow_body.elapsed_ms >= 180, `took ${obs.slow_body.elapsed_ms}ms`);
    const entry = entry_for(entries, 'slow-body-probe');
    assert.equal(entry.delivered.outcome, 'complete');
    assert.equal(entry.delivered.bytes, obs.slow_body.bytes);
  });
  return { ...files, obs, script, run_dir, stderr: result.stderr };
}
