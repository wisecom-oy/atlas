/**
 * Unit checks for the review fixes: tenant-content redaction, fault safety
 * limits, --upstream rules, identity refinements, exit codes, the atomic
 * identity key and the project-root tool home.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize_url } from '../../../graph-tap/redact.mjs';
import { exit_code_for } from '../child-process.mjs';
import { parse_run_args } from '../cli-args.mjs';
import { fault_applies, get_fault } from '../fault-catalog.mjs';
import { plan_fault } from '../fault-planner.mjs';
import { build_error_response } from '../faults/graph-error-responses.mjs';
import { create_identity_ordinals } from '../identity-ordinals.mjs';
import { classify_service, is_m365_host } from '../m365-hosts.mjs';
import { get_profile, total_rate } from '../profiles.mjs';
import { base_identity, compose_identity, content_range_start } from '../request-identity.mjs';
import { find_project_root } from '../run-directory.mjs';
import { request_rng } from '../seeded-random.mjs';
import { TENANT_CONTENT } from './journal-assertions.mjs';

const G1 = '11111111-2222-3333-4444-555555555555';
const GRAPH = 'https://graph.microsoft.com';

/** [origin, raw path, expected redaction], one per tenant-content shape. */
const REDACTION_SHAPES = [
  [
    GRAPH,
    '/v1.0/users/jane@contoso.com/drive/root:/Finance/Q1%20budget.xlsx:/content',
    'graph.microsoft.com/v1.0/users/{upn}/drive/root:/{path}:/content',
  ],
  [
    GRAPH,
    '/v1.0/sites/contoso.sharepoint.com:/sites/finance-team',
    'graph.microsoft.com/v1.0/sites/{host}:/{path}',
  ],
  [
    GRAPH,
    `/v1.0/sites/contoso.sharepoint.com,${G1},${G1}/drives`,
    'graph.microsoft.com/v1.0/sites/{site}/drives',
  ],
  [
    'https://contoso-my.sharepoint.com',
    `/personal/jane_contoso_com/_api/v2.0/drives/b!x/items/01A/uploadSession?guid='${G1}'`,
    "{tenant}-my.sharepoint.com/personal/{upn}/_api/v2.0/drives/{id}/items/{id}/uploadSession?guid='{value}'",
  ],
  [
    'https://contoso-admin.sharepoint.com',
    '/sites/finance',
    '{tenant}-admin.sharepoint.com/sites/{site}',
  ],
  [
    'https://contoso.sharepoint.com',
    '/sites/finance-team/Shared%20Documents/Q1%20budget.xlsx',
    '{tenant}.sharepoint.com/sites/{site}/{path}/{path}',
  ],
  [
    GRAPH,
    '/v1.0/users?$filter=startswith(displayName,\'finance\')&$search="budget"',
    "graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'{value}')&$search={value}",
  ],
  [
    GRAPH,
    '/v1.0/users?$filter=mail eq jane@contoso.com',
    'graph.microsoft.com/v1.0/users?$filter=mail eq {upn}',
  ],
  [
    'https://login.microsoftonline.com',
    '/contoso.onmicrosoft.com/oauth2/v2.0/token',
    'login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
  ],
  [
    'https://login.microsoftonline.com',
    `/${G1}/oauth2/v2.0/token`,
    'login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
  ],
  [
    GRAPH,
    '/v1.0/drives/b!Ab/items/01X/children',
    'graph.microsoft.com/v1.0/drives/{id}/items/{id}/children',
  ],
  [
    GRAPH,
    '/v1.0/users/jane/mailFolders/inbox/messages/AAMk1',
    'graph.microsoft.com/v1.0/users/{id}/mailFolders/inbox/messages/{id}',
  ],
  [GRAPH, '/v1.0/users/delta?$select=id', 'graph.microsoft.com/v1.0/users/delta?$select=id'],
  [
    GRAPH,
    '/v1.0/teams/finance/channels/general/messages',
    'graph.microsoft.com/v1.0/teams/{id}/channels/{id}/messages',
  ],
  [
    'https://outlook.office.com',
    '/api/v2.0/me/x?authtoken=abcd',
    'outlook.office.com/api/v2.0/me/x?authtoken=<4b>',
  ],
];

/** Registers the review-fix unit checks. */
export async function run_safety_unit_checks(check) {
  await check(
    'tenant content in URLs is templated: paths, sites, hosts, literals, tenants, ids by position',
    () => {
      for (const [origin, path, expected] of REDACTION_SHAPES) {
        const got = normalize_url(origin, path);
        assert.equal(got, expected);
        assert.ok(!TENANT_CONTENT.test(got), got);
      }
    },
  );
  await check('content faults are GET only and lost_response never hits a download', () => {
    for (const id of ['malformed_json', 'empty_body_200']) {
      assert.ok(
        !fault_applies(get_fault(id), { service: 'outlook', kind: 'write', method: 'POST' }),
        id,
      );
    }
    const plan = {
      rates: { lost_response: 0.95 },
      params: {},
      outages: [],
      services_filter: null,
      max_hold_ms: 1000,
      replay: false,
    };
    for (let i = 0; i < 40; i += 1) {
      const decision = plan_fault({
        request: { service: 'transfer', kind: 'download', method: 'GET' },
        elapsed_ms: 0,
        plan,
        rng: request_rng('s', `d${i}`, 1),
      });
      assert.equal(decision, null);
    }
  });
  await check('--upstream allows plain http only to loopback and never echoes credentials', () => {
    const run = (url) => parse_run_args(['--upstream', url, '--', 'node']);
    for (const ok of [
      'http://127.0.0.1:9',
      'http://localhost:9',
      'http://[::1]:9',
      'https://graph.example.com',
    ])
      run(ok);
    assert.throws(() => run('http://10.0.0.5:8080'), /loopback/);
    for (const secret of ['https://user:hunter2@example.com', 'https://:hunter2@example.com']) {
      assert.throws(
        () => run(secret),
        (error) => !error.message.includes('hunter2'),
      );
    }
  });
  await check('Outlook upload hosts are transfer hosts; 410 Location keeps $select', () => {
    assert.ok(is_m365_host('outlook.office.com') && is_m365_host('outlook.office365.com'));
    assert.equal(classify_service('outlook.office.com', '/api/v2.0/x'), 'transfer');
    const response = build_error_response('delta_resync_410', {
      service: 'outlook',
      params: { sub_seed: '1' },
      origin: GRAPH,
      path: '/v1.0/me/messages/delta?$select=id&$deltatoken=abc',
    });
    assert.equal(response.headers.location, `${GRAPH}/v1.0/me/messages/delta?$select=id`);
  });
  await check('upload fragments and pages get stable ordinals in their identity', () => {
    const ordinals = create_identity_ordinals();
    const base = base_identity(
      'PUT',
      'https://contoso-my.sharepoint.com',
      "/p/uploadSession?guid='a'",
      true,
    );
    assert.equal(ordinals.session_ordinal(base, 'url-a'), 1);
    assert.equal(ordinals.session_ordinal(base, 'url-b'), 2);
    assert.equal(ordinals.session_ordinal(base, 'url-a'), 1);
    assert.equal(content_range_start('bytes 327680-655359/1048576'), 327680);
    assert.deepEqual(
      ['A', 'B', 'A', 'C'].map((c) => ordinals.page_ordinal('GET x', c)),
      [1, 2, 1, 3],
    );
    assert.notEqual(
      compose_identity(base, { session: 1, offset: 0 }),
      compose_identity(base, { session: 1, offset: 10 }),
    );
    assert.notEqual(
      compose_identity('POST b', { body_digest: 'aa' }),
      compose_identity('POST b', { body_digest: 'bb' }),
    );
  });
  await check('a signal exit maps to 128 plus its number', () => {
    assert.equal(exit_code_for({ exit_code: null, signal: 'SIGTERM' }), 143);
    assert.equal(exit_code_for({ exit_code: null, signal: 'SIGUSR1' }), 128 + 10);
    assert.equal(exit_code_for({ error: 'ENOENT' }), 127);
  });
  await check('the chaos summary states its real total', () => {
    const chaos = get_profile('chaos');
    assert.ok(
      chaos.summary.includes(`${Math.round(total_rate(chaos.rates) * 100)} %`),
      chaos.summary,
    );
  });
  await check('the tool home is the nearest ancestor with .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'outagesoft-365-root-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    try {
      assert.equal(find_project_root(join(root, 'packages', 'cli')), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await check('concurrent first runs agree on one identity key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'outagesoft-365-key-'));
    const store = new URL('../identity-key-store.mjs', import.meta.url).href;
    const source = `const { load_or_create_identity_key } = await import(${JSON.stringify(store)});
      process.stdout.write(load_or_create_identity_key(${JSON.stringify(home)}).toString('hex'));`;
    const keys = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
              stdio: ['ignore', 'pipe', 'inherit'],
            });
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.on('error', reject);
            child.on('close', () => resolve(out));
          }),
      ),
    );
    rmSync(home, { recursive: true, force: true });
    assert.ok(
      keys.every((k) => /^[0-9a-f]{64}$/.test(k) && k === keys[0]),
      keys.join(' '),
    );
  });
}
