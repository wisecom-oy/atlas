/**
 * The child script for the fault-shape checks, as source text.
 *
 * It talks to the real Microsoft 365 hostnames; only the preload's re-route
 * sends it to the relay. Each probe forces one fault with the test-only
 * header and records what the client actually saw (status, error codes,
 * undici error names) into OBS_FILE for the parent to assert on.
 */

/** A bearer token that must never reach any output file. */
export const SECRET_BEARER = 'eyJ0eXAiOiJKV1QifQ.SECRET_BEARER_TOKEN_5c1e.sig';
/** A client secret sent in a token request body; must never reach any output file. */
export const SECRET_CLIENT = 'SECRET_CLIENT_VALUE_9d2b';
/** The child's exit code; the run must return it unchanged. */
export const CHILD_EXIT_CODE = 7;

/** A long opaque message id that must be templated to {id}. */
export const LONG_ID = `AAMkAGI2THVSAAA${'x'.repeat(60)}`;

export const FAULT_SHAPES_CHILD = `
import https from 'node:https';
import { writeFileSync } from 'node:fs';
const G = 'https://graph.microsoft.com/v1.0';
const auth = { authorization: 'Bearer ${SECRET_BEARER}' };
const obs = {};
const forced = (id, extra = {}) => ({ ...extra, headers: { ...auth, 'x-outagesoft-force': id, ...(extra.headers ?? {}) } });
const failure = (error) => ({ name: error.name, message: error.message, cause: error.cause?.code ?? error.cause?.name ?? error.cause?.message });
async function probe(name, fn) {
  try { obs[name] = await fn(); } catch (error) { obs[name] = { threw: failure(error) }; }
}
const msg_url = G + '/users/user@example.com/messages/${LONG_ID}';

await probe('plain', async () => {
  const res = await fetch(msg_url, { headers: auth });
  return { status: res.status, url: res.url, body: await res.text() };
});
await probe('throttle_outlook', async () => {
  const res = await fetch(G + '/users/user@example.com/messages', forced('throttle_429'));
  return { status: res.status, retry_after: res.headers.get('retry-after'), body: await res.json() };
});
await probe('throttle_drive', async () => {
  const res = await fetch(G + '/users/user@example.com/drive/root/children', forced('throttle_429'));
  return { status: res.status, retry_after: res.headers.get('retry-after'), body: await res.json() };
});
await probe('html_503', async () => {
  const res = await fetch(G + '/users', forced('html_503'));
  return { status: res.status, type: res.headers.get('content-type'), retry_after: res.headers.get('retry-after'), body: await res.text() };
});
await probe('reset', async () => {
  const res = await fetch(G + '/selfcheck/reset-probe', forced('connection_reset'));
  return { status: res.status };
});
await probe('no_response', async () => {
  const started = Date.now();
  try { await fetch(G + '/selfcheck/hold-probe', forced('no_response')); return { resolved: true }; }
  catch (error) { return { threw: failure(error), waited_ms: Date.now() - started }; }
});
await probe('truncated', async () => {
  const res = await fetch(G + '/selfcheck/truncate-probe', forced('truncated_body'));
  try { await res.text(); return { status: res.status, read: 'complete' }; }
  catch (error) { return { status: res.status, read_error: failure(error) }; }
});
await probe('truncated_chunked', async () => {
  const res = await fetch(G + '/selfcheck/truncate-probe?chunked=1', forced('truncated_body'));
  try { await res.text(); return { status: res.status, read: 'complete' }; }
  catch (error) { return { status: res.status, read_error: failure(error) }; }
});
await probe('malformed', async () => {
  const res = await fetch(G + '/selfcheck/malformed-probe', forced('malformed_json'));
  try { await res.json(); return { status: res.status, parsed: true }; }
  catch (error) { return { status: res.status, parse_error: error.name }; }
});
await probe('duplicates', async () => {
  const res = await fetch(G + '/selfcheck/dup-probe?gzip=1', forced('duplicate_items'));
  const body = await res.json();
  return { status: res.status, count: body.value.length, encoding: res.headers.get('content-encoding') };
});
await probe('next_link', async () => {
  const res = await fetch(G + '/selfcheck/next-probe', forced('drop_next_link'));
  const body = await res.json();
  return { has_next: '@odata.nextLink' in body, count: body.value.length };
});
await probe('batch', async () => {
  const res = await fetch(G + '/$batch', forced('batch_inner_429', { method: 'POST', body: JSON.stringify({ requests: [] }), headers: { 'content-type': 'application/json' } }));
  const body = await res.json();
  return { status: res.status, inner: body.responses.map((r) => ({ status: r.status, retry_after: r.headers?.['Retry-After'] })) };
});
await probe('out_of_order', async () => {
  const order = [];
  const a = fetch(G + '/selfcheck/ooo-a', forced('out_of_order')).then((r) => r.text()).then(() => order.push('a'));
  await new Promise((r) => setTimeout(r, 40));
  const b = fetch(G + '/selfcheck/ooo-b?delay=20', { headers: auth }).then((r) => r.text()).then(() => order.push('b'));
  await Promise.all([a, b]);
  return { order };
});
await probe('lost_response', async () => {
  const res = await fetch(G + '/users/user@example.com/sendMail', forced('lost_response', { method: 'POST', body: JSON.stringify({ message: 'hello' }) }));
  return { status: res.status };
});
await probe('wrong_token', async () => {
  const res = await fetch(process.env.OUTAGESOFT_RELAY + '/not-the-token/' + encodeURIComponent('https://graph.microsoft.com') + '/v1.0/wrong-token-probe');
  return { status: res.status };
});
await probe('identity', () => new Promise((resolve, reject) => {
  const req = https.request('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    (res) => { let text = ''; res.on('data', (d) => (text += d)); res.on('end', () => resolve({ status: res.statusCode, body: text })); });
  req.on('error', reject);
  req.end('grant_type=client_credentials&client_secret=${SECRET_CLIENT}');
}));
await probe('slow_first_byte', async () => {
  const started = Date.now();
  const res = await fetch(G + '/selfcheck/slow-probe', forced('slow_first_byte'));
  await res.text();
  return { status: res.status, elapsed_ms: Date.now() - started };
});
await probe('slow_body', async () => {
  const started = Date.now();
  const res = await fetch(G + '/selfcheck/slow-body-probe', forced('slow_body'));
  const body = await res.text();
  return { status: res.status, bytes: body.length, elapsed_ms: Date.now() - started };
});

writeFileSync(process.env.OBS_FILE, JSON.stringify(obs));
process.exit(${CHILD_EXIT_CODE});
`;
