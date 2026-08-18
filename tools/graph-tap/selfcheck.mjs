/**
 * End-to-end self-check for graph-tap. No network, no credentials.
 *
 * Runs the real tap over a child process talking to a local server, then asserts
 * on the capture it produced. The first assertion is the one that matters: a
 * bearer token must never reach a capture file. The rest cover the parsing that
 * makes a capture readable -- token elision, id templating, and gzip error
 * decoding, which is easy to break and silently degrades to binary noise.
 *
 * Run with: tools/graph-tap/graph-tap selfcheck
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'graph-tap-selfcheck-'));
const capture = join(work, 'capture.jsonl');
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.SECRET_BEARER_TOKEN.signature';

const server = createServer((req, res) => {
  if (req.url.startsWith('/error')) {
    // Graph gzips its error payloads; the tap must inflate before parsing.
    const body = gzipSync(
      JSON.stringify({
        error: { code: 'ErrorItemNotFound', message: 'The specified object\n  was not found.' },
      }),
    );
    res.writeHead(404, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'retry-after': '17',
      'x-ms-ags-diagnostic': JSON.stringify({ ServerInfo: { DataCenter: 'West Europe' } }),
    });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"value":[]}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const long_id = 'AAMkAGI2THVSAAA' + 'x'.repeat(60);
const child = join(work, 'child.mjs');
writeFileSync(
  child,
  `
const auth = { Authorization: 'Bearer ${TOKEN}' };
await fetch('${base}/v1.0/users/user@example.com/messages/${long_id}', { headers: auth });
await fetch('${base}/v1.0/users/user@example.com/messages/delta?$deltatoken=${'D'.repeat(500)}&$select=id,subject', { headers: auth });
await fetch('${base}/error/v1.0/users/00000000-1111-2222-3333-444444444444/drive', { headers: auth });
await fetch('${base}/v1.0/upload?tempauth=${'T'.repeat(200)}', { method: 'POST', headers: auth, body: '{"hello":"world"}' });
`,
);

// Must be async: spawnSync would block this process's event loop, so the local
// server could never answer the child and the two would deadlock.
const child_proc = spawn(process.execPath, [child], {
  env: {
    ...process.env,
    NODE_OPTIONS: `--import="${join(here, 'tap.mjs')}"`,
    GRAPH_TAP_OUT: capture,
    GRAPH_TAP_ALL: '1', // the local server is not a Microsoft host
    GRAPH_TAP_QUIET: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let child_err = '';
child_proc.stderr.on('data', (d) => (child_err += d));
const status = await new Promise((resolve, reject) => {
  child_proc.on('error', reject);
  child_proc.on('close', resolve);
});
server.closeAllConnections();
server.close();
assert.equal(status, 0, `child process failed: ${child_err}`);

const raw = readFileSync(capture, 'utf8');
const records = raw
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

check('bearer token never reaches the capture', () => {
  assert.ok(!raw.includes('SECRET_BEARER_TOKEN'), 'token found in capture');
  assert.ok(!raw.toLowerCase().includes('authorization'), 'authorization header recorded');
});

check('every request was captured', () => assert.equal(records.length, 4));

check('long opaque ids are templated', () => {
  assert.ok(
    records.some((r) => r.url.includes('/messages/{id}')),
    `expected {id} template, got: ${records.map((r) => r.url).join(' ')}`,
  );
});

check('upns and guids are templated', () => {
  assert.ok(records.every((r) => !r.url.includes('user@example.com')));
  assert.ok(records.some((r) => r.url.includes('{upn}')));
  assert.ok(records.some((r) => r.url.includes('{guid}')));
});

check('delta tokens are elided to a byte count', () => {
  const delta = records.find((r) => r.url.includes('$deltatoken'));
  assert.match(delta.url, /\$deltatoken=<500b>/);
  assert.ok(delta.url.includes('$select=id,subject'), 'useful params must survive');
});

check('download-url credentials are elided', () => {
  const upload = records.find((r) => r.url.includes('tempauth'));
  assert.match(upload.url, /tempauth=<200b>/);
  assert.ok(!upload.url.includes('TTTT'));
});

check('gzipped graph errors are decoded and flattened', () => {
  const err = records.find((r) => r.status === 404);
  assert.equal(err.graph_error.code, 'ErrorItemNotFound');
  assert.equal(err.graph_error.message, 'The specified object was not found.');
});

check('throttling headers kept, diagnostic noise dropped', () => {
  const err = records.find((r) => r.status === 404);
  assert.equal(err.res_headers['retry-after'], '17');
  assert.ok(!('x-ms-ags-diagnostic' in err.res_headers));
  assert.ok(!('content-type' in (err.res_headers ?? {})), 'plain JSON content-type is noise');
});

check('timing and byte counts are recorded', () => {
  const upload = records.find((r) => r.method === 'POST');
  assert.equal(typeof upload.ms, 'number');
  assert.equal(upload.tx, 17, 'request body bytes'); // {"hello":"world"} is 17 bytes
  assert.ok(records.every((r) => r.rx > 0));
});

check('request bodies are not recorded without --bodies', () => {
  assert.ok(!raw.includes('hello'), 'body captured despite --bodies being off');
});

for (const name of checks) console.log(`  ok  ${name}`);
console.log(`\n${checks.length} checks passed`);
