/**
 * A local stand-in for Graph and Entra ID, used as `--upstream` by the selfcheck.
 *
 * Every response body carries BODY_MARKER, so the checks can prove no body
 * content reaches the journal or the reports. It records what reached it
 * (method, path, whether an Authorization header arrived, body size) so the
 * checks can tell forwarded requests from synthetic answers.
 */
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

/** Text present in every fake response body; must never appear in any output file. */
export const BODY_MARKER = 'BODY_CONTENT_MARKER_7f3a';

/** Upper bound on the `?delay=` a request may ask for, so a response timer is never unbounded. */
const MAX_DELAY_MS = 10_000;

/** A Graph-like collection page with three items and a nextLink. */
function collection_page() {
  return JSON.stringify({
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users',
    value: [
      { id: 'item-1', subject: BODY_MARKER },
      { id: 'item-2', subject: 'second' },
      { id: 'item-3', subject: 'third' },
    ],
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/next?$skiptoken=abc',
  });
}

/** A $batch response with three successful sub-responses. */
function batch_page() {
  return JSON.stringify({
    responses: ['1', '2', '3'].map((id) => ({
      id,
      status: 200,
      headers: {},
      body: { marker: BODY_MARKER },
    })),
  });
}

/** Chooses the response body for a path. */
function body_for(path) {
  if (path.includes('/oauth2/v2.0/token'))
    return JSON.stringify({ token_type: 'Bearer', expires_in: 3599, access_token: BODY_MARKER });
  if (path.includes('$batch')) return batch_page();
  return collection_page();
}

/** Starts the fake upstream; resolves { base, seen, close() }. */
export async function start_fake_graph() {
  const seen = [];
  const server = createServer((req, res) => {
    const record = {
      method: req.method,
      path: req.url,
      authorized: Boolean(req.headers.authorization),
      host: req.headers.host,
      body_bytes: 0,
    };
    seen.push(record);
    req.on('data', (chunk) => {
      record.body_bytes += chunk.length;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const requested_delay = Number(url.searchParams.get('delay')) || 0;
      const delay = Math.min(Math.max(requested_delay, 0), MAX_DELAY_MS);
      setTimeout(() => {
        let body = Buffer.from(body_for(req.url));
        const headers = { 'content-type': 'application/json; charset=utf-8' };
        if (url.searchParams.get('gzip') === '1') {
          body = gzipSync(body);
          headers['content-encoding'] = 'gzip';
        }
        if (url.searchParams.get('chunked') !== '1')
          headers['content-length'] = String(body.length);
        res.writeHead(200, headers);
        res.end(body);
      }, delay);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
