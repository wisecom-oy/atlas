/**
 * Checks of the pure modules: parsing, classification, identity, planning.
 * Fast and deterministic; they run before the end-to-end scenarios.
 */
import assert from 'node:assert/strict';
import { parse_run_args } from '../cli/cli-args.mjs';
import { parse_duration } from '../shared/duration.mjs';
import { FAULTS } from '../faults/fault-catalog.mjs';
import { plan_fault } from '../planning/fault-planner.mjs';
import { classify_kind, classify_service, is_m365_host } from '../request/m365-hosts.mjs';
import { parse_outage_spec } from '../planning/outage-schedule.mjs';
import { validate_profile } from '../planning/profile-file.mjs';
import { decode_relay_path, encode_relay_path } from '../request/relay-route.mjs';
import { is_idempotent, request_cursor, base_identity } from '../request/request-identity.mjs';
import { effective_rates } from '../run/run-plan.mjs';
import { request_rng } from '../planning/seeded-random.mjs';
import { build_error_response } from '../faults/graph-error-responses.mjs';
import { redact_request_url } from '../relay/journal.mjs';
import { DEFAULT_HOSTS } from '../../../graph-tap/redact.mjs';

const BASE_PLAN = {
  rates: {},
  params: {},
  outages: [],
  services_filter: null,
  max_hold_ms: 120000,
  replay: false,
};
const RUN = (...args) => parse_run_args([...args, '--', 'node', 'x.mjs']);

/** Registers the pure-module checks. */
export async function run_unit_checks(check) {
  await check('invalid input is rejected with the bad value named', () => {
    assert.throws(() => RUN('--profile', 'stormy'), /stormy/);
    assert.throws(() => RUN('--faults', 'throttle_429,throtle_500'), /throtle_500/);
    assert.throws(() => RUN('--max-hold', '120'), /'120'/);
    assert.throws(() => RUN('--services', 'exchange'), /exchange/);
    assert.throws(() => RUN('--outage', 'outlook:30s:2m:slow_body'), /slow_body/);
    assert.throws(() => RUN('--intensity', '-1'), /-1/);
    assert.throws(() => RUN('--replay', 'x', '--seed', '1'), /--seed/);
    assert.throws(() => parse_run_args(['--profile', 'flaky']), /no command/);
    assert.throws(
      () => validate_profile({ id: 'x', severity: 1, rates: { throttle_429: 2 } }),
      /throttle_429/,
    );
    assert.throws(() => validate_profile({ id: 'x', severity: 1, rates: { nope: 0.1 } }), /nope/);
    assert.equal(parse_duration('1.5s'), 1500);
    assert.equal(parse_outage_spec('outlook:30s:2m:no_response').duration_ms, 120000);
  });
  await check('relay path encoding round-trips and refuses smuggled origins', () => {
    const path = encode_relay_path('tok', 'https://graph.microsoft.com', '/v1.0/me?$top=1');
    assert.deepEqual(decode_relay_path(path), {
      token: 'tok',
      origin: 'https://graph.microsoft.com',
      path: '/v1.0/me?$top=1',
    });
    assert.equal(
      decode_relay_path(`/tok/${encodeURIComponent('https://graph.microsoft.com/x')}/y`),
      null,
    );
    assert.equal(
      decode_relay_path(`/tok/${encodeURIComponent('https://a@graph.microsoft.com')}/y`),
      null,
    );
  });
  await check('host allowlist is anchored and agrees with graph-tap', () => {
    assert.ok(is_m365_host('graph.microsoft.com') && is_m365_host('contoso-my.sharepoint.com'));
    assert.ok(!is_m365_host('graph.microsoft.com.example.net') && !is_m365_host('sharepoint.com'));
    const tap = new RegExp(DEFAULT_HOSTS, 'i');
    for (const host of [
      'graph.microsoft.com',
      'login.microsoftonline.com',
      'contoso.sharepoint.com',
      '1drv.ms',
    ]) {
      assert.ok(tap.test(host), host);
    }
  });
  await check('services and request kinds are classified', () => {
    const G = 'graph.microsoft.com';
    assert.equal(classify_service(G, '/v1.0/users/x/mailFolders/inbox/messages/delta'), 'outlook');
    assert.equal(
      classify_kind('outlook', 'GET', '/v1.0/users/x/mailFolders/inbox/messages/delta'),
      'delta',
    );
    assert.equal(classify_service(G, '/v1.0/users/x/drive/items/1/content'), 'onedrive');
    assert.equal(
      classify_kind('onedrive', 'GET', '/v1.0/users/x/drive/items/1/content'),
      'download',
    );
    assert.equal(classify_service(G, '/v1.0/sites/s/drives'), 'sharepoint');
    assert.equal(classify_service(G, '/v1.0/teams/t/channels'), 'teams');
    assert.equal(classify_service(G, '/v1.0/groups'), 'directory');
    assert.equal(classify_kind('directory', 'POST', '/v1.0/$batch'), 'batch');
    assert.equal(
      classify_service('contoso-my.sharepoint.com', '/personal/x/uploadSession'),
      'transfer',
    );
    assert.equal(classify_kind('transfer', 'PUT', '/x'), 'upload');
    assert.equal(classify_kind('identity', 'POST', '/t/oauth2/v2.0/token'), 'token');
  });
  await check('request identity drops volatile parameters and sorts the rest', () => {
    const a = base_identity(
      'GET',
      'https://graph.microsoft.com',
      '/v1.0/me/messages/delta?$select=id&$deltatoken=AAA',
    );
    const b = base_identity(
      'GET',
      'https://graph.microsoft.com',
      '/v1.0/me/messages/delta?$deltatoken=BBB&$select=id',
    );
    assert.equal(a, b);
    const s1 = base_identity(
      'PUT',
      'https://contoso-my.sharepoint.com',
      `/personal/x/_api/v2.0/drives/b/items/${'A1'.repeat(15)}/uploadSession?guid='1'&tempauth=x`,
      true,
    );
    const s2 = base_identity(
      'PUT',
      'https://contoso-my.sharepoint.com',
      `/personal/x/_api/v2.0/drives/b/items/${'B2'.repeat(15)}/uploadSession?guid='2'&tempauth=y`,
      true,
    );
    assert.equal(s1, s2);
    assert.equal(request_cursor('/v1.0/me/messages/delta?$deltatoken=x', 'delta'), 'delta');
    assert.equal(request_cursor('/v1.0/drives/d/root/delta?token=x', 'delta'), 'delta');
    assert.equal(request_cursor('/v1.0/users?$skiptoken=x', 'read'), 'skip');
    assert.equal(is_idempotent('PATCH', false, 'write'), false);
    assert.equal(is_idempotent('PATCH', true, 'write'), true);
    assert.equal(is_idempotent('POST', false, 'token'), true);
  });
  await check('journal URLs are redacted, including addresses in query values', () => {
    const url = redact_request_url(
      'https://graph.microsoft.com',
      "/v1.0/users/user@example.com/messages?$filter=from/emailAddress/address eq 'user@example.com'&$skiptoken=SECRET",
    );
    assert.ok(!url.includes('user@example.com') && !url.includes('SECRET'), url);
  });
  await check('the planner keys decisions by seed, identity and occurrence', () => {
    const plan = { ...BASE_PLAN, rates: { throttle_429: 0.5 } };
    const request = { service: 'outlook', kind: 'read', method: 'GET' };
    const run = (seed, key, n) =>
      plan_fault({ request, elapsed_ms: 0, plan, rng: request_rng(seed, key, n) });
    const first = Array.from({ length: 40 }, (_, i) => run('s', `k${i}`, 1));
    assert.deepEqual(
      first,
      Array.from({ length: 40 }, (_, i) => run('s', `k${i}`, 1)),
    );
    assert.ok(first.some(Boolean) && first.some((d) => !d));
    assert.notDeepEqual(
      first,
      Array.from({ length: 40 }, (_, i) => run('t', `k${i}`, 1)),
    );
  });
  await check('faults only land where they apply; identity outages map to token faults', () => {
    const plan = { ...BASE_PLAN, rates: { delta_resync_410: 0.95 } };
    for (let i = 0; i < 50; i += 1) {
      const read = plan_fault({
        request: { service: 'outlook', kind: 'read', method: 'GET' },
        elapsed_ms: 0,
        plan,
        rng: request_rng('s', `r${i}`, 1),
      });
      assert.equal(read, null);
    }
    const outage = {
      ...BASE_PLAN,
      outages: [{ service: 'all', start_ms: 0, duration_ms: 1000, fault: 'throttle_429' }],
    };
    const token = plan_fault({
      request: { service: 'identity', kind: 'token', method: 'POST' },
      elapsed_ms: 10,
      plan: outage,
      rng: request_rng('s', 'x', 1),
    });
    assert.equal(token.id, 'token_endpoint_429');
    assert.equal(token.source, 'outage');
    const after = plan_fault({
      request: { service: 'outlook', kind: 'read', method: 'GET' },
      elapsed_ms: 1000,
      plan: outage,
      rng: request_rng('s', 'x', 1),
    });
    assert.equal(after, null);
  });
  await check('intensity scales rates and the total is clamped to 0.95', () => {
    const rates = effective_rates(
      { throttle_429: 0.4, server_500: 0.4 },
      { only_faults: null, exclude_faults: ['server_500'], intensity: 2 },
    );
    assert.deepEqual(rates, { throttle_429: 0.8 });
    const clamped = effective_rates(
      { throttle_429: 0.5, server_500: 0.5 },
      { only_faults: null, exclude_faults: null, intensity: 1 },
    );
    assert.ok(Math.abs(clamped.throttle_429 + clamped.server_500 - 0.95) < 1e-6);
  });
  await check('every synthetic fault has a wire shape, and Graph errors carry innerError', () => {
    for (const fault of FAULTS.filter(
      (f) => !f.forwards && !['connection_reset', 'no_response'].includes(f.id),
    )) {
      const response = build_error_response(fault.id, {
        service: fault.services[0],
        params: { retry_after_s: 7, status: 410, sub_seed: '1' },
        origin: 'https://graph.microsoft.com',
        path: '/v1.0/x',
      });
      assert.ok(response.status >= 400, fault.id);
      if (
        fault.id.startsWith('token_') ||
        fault.id === 'html_503' ||
        fault.id === 'download_url_expired_401'
      )
        continue;
      assert.ok(JSON.parse(response.body).error.innerError['client-request-id'], fault.id);
    }
  });
}
