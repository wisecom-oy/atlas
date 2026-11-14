/**
 * A self-contained check that both re-routes work in a fresh node process:
 * a local fake upstream, a passthrough relay pointed at it, and a child with
 * the preload that calls Graph through fetch and Entra ID through node:https.
 * Used by `doctor`. Needs no network and no credentials.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { node_options_with_preload } from './child-process.mjs';
import { open_journal } from './journal.mjs';
import { start_relay } from './relay-server.mjs';

const PROBE_CHILD = `
import https from 'node:https';
const out = {};
try {
  const res = await fetch('https://graph.microsoft.com/v1.0/probe');
  out.fetch_status = res.status;
  out.fetch_url = res.url;
} catch (error) { out.fetch_error = String(error.cause?.code ?? error.message); }
try {
  out.https_status = await new Promise((resolve, reject) => {
    const req = https.request('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('grant_type=client_credentials');
  });
} catch (error) { out.https_error = String(error.code ?? error.message); }
process.stdout.write(JSON.stringify(out));
`;

/** Starts a fake upstream that records which paths reached it. */
async function start_fake_upstream(seen) {
  const server = createServer((req, res) => {
    seen.push(req.url);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** Runs the probe child with the preload; resolves its parsed JSON output and stderr. */
function run_probe_child(relay_url, token) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', PROBE_CHILD], {
      env: {
        ...process.env,
        NODE_OPTIONS: node_options_with_preload(process.env.NODE_OPTIONS),
        OUTAGESOFT_RELAY: relay_url,
        OUTAGESOFT_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ output: {}, stderr: String(error) }));
    child.on('close', () => {
      let output = {};
      try {
        output = JSON.parse(stdout);
      } catch {
        /* reported below as missing fields */
      }
      resolve({ output, stderr });
    });
  });
}

/** Runs the probe; resolves { fetch_ok, https_ok, detail }. */
export async function probe_reroutes() {
  const work = mkdtempSync(join(tmpdir(), 'outagesoft-365-doctor-'));
  const seen = [];
  const upstream = await start_fake_upstream(seen);
  const journal = open_journal(join(work, 'journal.jsonl'));
  const token = randomBytes(16).toString('hex');
  const relay = await start_relay({
    token,
    identity_secret: randomBytes(32),
    seed: 'doctor',
    plan: {
      rates: {},
      params: {},
      outages: [],
      services_filter: null,
      max_hold_ms: 1000,
      replay: false,
    },
    journal,
    upstream_base: `http://127.0.0.1:${upstream.address().port}`,
    quiet: true,
    allow_force: false,
    replay_source: null,
  });
  try {
    const { output, stderr } = await run_probe_child(relay.url, token);
    return {
      fetch_ok:
        output.fetch_status === 200 &&
        output.fetch_url === 'https://graph.microsoft.com/v1.0/probe' &&
        seen.includes('/v1.0/probe'),
      https_ok: output.https_status === 200 && seen.includes('/common/oauth2/v2.0/token'),
      detail: { output, warnings: stderr.trim() },
    };
  } finally {
    await relay.close();
    journal.close();
    upstream.closeAllConnections();
    upstream.close();
    rmSync(work, { recursive: true, force: true });
  }
}
