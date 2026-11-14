/**
 * End-to-end checks of request identity and tenant-content redaction.
 *
 * The child requests realistic tenant-shaped URLs (file paths, site names,
 * owners, filters, upload sessions, paging cursors, JSON bodies) under the
 * contoso fixture names. It runs twice; identity keys must agree between the
 * runs, and none of the fixture names may reach any output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { write_report } from '../report/write-report.mjs';
import { assert_clean, entry_for } from './journal-assertions.mjs';
import { read_run, run_cli, write_script } from './run-harness.mjs';

const IDENTITY_CHILD = `
const G = 'https://graph.microsoft.com/v1.0';
const G1 = '11111111-2222-3333-4444-555555555555';
const call = async (url, init = {}) => { try { const r = await fetch(url, init); await r.text(); } catch {} };
const json = (body, extra = {}) => ({ method: 'POST', body: JSON.stringify(body), ...extra, headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) } });

await call(G + '/users/jane@contoso.com/drive/root:/Finance/Q1%20budget.xlsx:/content');
await call(G + '/sites/contoso.sharepoint.com:/sites/finance-team');
await call(G + '/sites/contoso.sharepoint.com,' + G1 + ',' + G1 + '/drives');
await call(G + "/users?$filter=startswith(displayName,'finance')&$search=%22budget%22");
await call('https://contoso.sharepoint.com/sites/finance-team/Shared%20Documents/Q1%20budget.xlsx');

await call(G + '/$batch', json({ requests: [{ id: '1', url: '/me' }] }));
await call(G + '/$batch', json({ requests: [{ id: '1', url: '/me' }] }));
await call(G + '/$batch', json({ requests: [{ id: '2', url: '/users' }] }));
await call(G + '/users/jane@contoso.com/mailFolders/inbox/messages', json({ subject: 'budget' }, { headers: { 'x-outagesoft-force': 'connection_reset' } }));

for (const session of ['1', '2']) {
  const url = 'https://contoso-my.sharepoint.com/personal/jane_contoso_com/_api/v2.0/drives/b!AbC/items/01ABC/uploadSession'
    + "?guid='" + session + "'&tempauth=t" + session;
  for (const [start, end] of [[0, 9], [10, 19]]) {
    await call(url, { method: 'PUT', body: 'x'.repeat(10), headers: { 'content-range': 'bytes ' + start + '-' + end + '/20' } });
  }
}
await call("https://outlook.office.com/api/v2.0/Users('jane@contoso.com')/Messages('AAMk1')/AttachmentSessions('AAMk2')?authtoken=abc",
  { method: 'PUT', body: 'x', headers: { 'content-range': 'bytes 0-0/1' } });

for (const cursor of ['AAA', 'BBB', 'AAA']) await call(G + '/users/jane@contoso.com/messages?$skiptoken=' + cursor);
`;

/** Runs the identity child once and returns the run's files and stderr. */
async function run_identity_child({ work, fake, name, script }) {
  const run_dir = join(work, name);
  const result = await run_cli(
    [
      'run',
      '--profile',
      'passthrough',
      '--seed',
      'identity',
      '--upstream',
      fake.base,
      '--out',
      run_dir,
      '--',
      process.execPath,
      script,
    ],
    { cwd: work },
  );
  assert.equal(result.code, 0, result.stderr);
  return { ...read_run(run_dir), run_dir, stderr: result.stderr };
}

/** Runs the identity scenario twice and registers its checks. */
export async function run_identity_checks({ work, fake, check }) {
  const script = write_script(work, 'identity-child.mjs', IDENTITY_CHILD);
  const first = await run_identity_child({ work, fake, name: 'run-identity-1', script });
  const second = await run_identity_child({ work, fake, name: 'run-identity-2', script });
  const { entries } = first;

  await check(
    'no tenant, site, file or person name reaches journal, run.json, stderr or reports',
    async () => {
      await write_report(first.run_dir);
      assert_clean(first.journal_text, 'journal');
      assert_clean(first.run_text, 'run.json');
      assert_clean(first.stderr, 'stderr');
      assert_clean(readFileSync(join(first.run_dir, 'report.json'), 'utf8'), 'report.json');
      assert_clean(readFileSync(join(first.run_dir, 'report.md'), 'utf8'), 'report.md');
    },
  );
  await check('JSON bodies split identities: same body repeats, different body is new', () => {
    const batches = entries.filter((e) => e.kind === 'batch');
    assert.equal(batches.length, 3);
    assert.equal(batches[0].identity_key, batches[1].identity_key);
    assert.deepEqual(
      batches.map((e) => e.occurrence),
      [1, 2, 1],
    );
    assert.notEqual(batches[0].identity_key, batches[2].identity_key);
    assert.ok(batches.every((e) => /^[0-9a-f]{16}$/.test(e.body_key)));
    assert.notEqual(batches[0].body_key, batches[2].body_key);
  });
  await check('a reset JSON POST still records its body_key', () => {
    const reset = entries.find((e) => e.fault?.id === 'connection_reset');
    assert.equal(reset.delivered.outcome, 'reset');
    assert.match(reset.body_key, /^[0-9a-f]{16}$/);
  });
  await check('upload fragments are identified by session ordinal and offset', () => {
    const fragments = entries.filter((e) => e.kind === 'upload' && e.url.includes('uploadSession'));
    assert.equal(fragments.length, 4);
    assert.equal(new Set(fragments.map((e) => e.identity_key)).size, 4);
    assert.ok(fragments.every((e) => e.occurrence === 1 && e.body_key && e.page === null));
    entry_for(entries, 'AttachmentSessions');
  });
  await check('paging cursors get page ordinals; a repeated cursor is a retry of its page', () => {
    const pages = entries.filter((e) => e.cursor === 'skip');
    assert.deepEqual(
      pages.map((e) => e.page),
      [1, 2, 1],
    );
    assert.equal(pages[0].identity_key, pages[2].identity_key);
    assert.notEqual(pages[0].identity_key, pages[1].identity_key);
    assert.deepEqual(
      pages.map((e) => e.occurrence),
      [1, 1, 2],
    );
    // Every page of the listing shares its base key, so a restart is distinguishable from a retry.
    assert.equal(new Set(pages.map((e) => e.base_key)).size, 1);
    assert.match(pages[0].base_key, /^[0-9a-f]{16}$/);
  });
  await check('identity keys are identical across two runs of the same sequential workload', () => {
    assert.deepEqual(
      second.entries.map((e) => [e.identity_key, e.occurrence]),
      entries.map((e) => [e.identity_key, e.occurrence]),
    );
  });
}
