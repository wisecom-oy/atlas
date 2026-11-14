/**
 * Checks that a bug inside the relay surfaces as a journaled relay_error and
 * a 502 `outagesoftRelayError`, never as a hung socket or a dead relay.
 *
 * The bug is planted through a plan that bypassed validation (an outage with
 * a fault id the catalog does not know), which makes the planner throw.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { open_journal } from '../relay/journal.mjs';
import { start_relay } from '../relay/relay-server.mjs';
import { encode_relay_path } from '../request/relay-route.mjs';

/** Registers the relay-error check. */
export async function run_relay_error_check({ work, fake, check }) {
  await check(
    'a relay bug becomes a journaled relay_error and a 502, and the relay keeps serving',
    async () => {
      const journal_path = join(work, 'relay-error.jsonl');
      const journal = open_journal(journal_path);
      const token = randomBytes(16).toString('hex');
      const relay = await start_relay({
        token,
        identity_secret: randomBytes(32),
        seed: 'bug',
        plan: {
          rates: {},
          params: {},
          outages: [{ service: 'outlook', start_ms: 0, duration_ms: 60000, fault: 'not_a_fault' }],
          services_filter: null,
          max_hold_ms: 1000,
          replay: false,
        },
        journal,
        upstream_base: fake.base,
        quiet: true,
        allow_force: false,
        replay_source: null,
      });
      try {
        const origin = 'https://graph.microsoft.com';
        const broken = await fetch(
          relay.url + encode_relay_path(token, origin, '/v1.0/me/messages'),
        );
        assert.equal(broken.status, 502);
        assert.equal((await broken.json()).error.code, 'outagesoftRelayError');
        const healthy = await fetch(relay.url + encode_relay_path(token, origin, '/v1.0/users'));
        assert.equal(healthy.status, 200);
        await healthy.text();
      } finally {
        await relay.close();
        journal.close();
      }
      const entries = readFileSync(journal_path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(entries[0].delivered.outcome, 'relay_error');
      assert.match(entries[0].relay_error, /TypeError/);
      assert.equal(relay.stats.relay_errors, 1);
      assert.equal(entries[1].delivered.outcome, 'complete');
    },
  );
}
