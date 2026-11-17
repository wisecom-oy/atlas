import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler, ResponseType } from '@microsoft/microsoft-graph-client';
import {
  binary_graph_response,
  graph_error_response,
  queued_graph_fetch,
  throttled_graph_response,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  get_graph_binary_response,
  get_graph_bytes,
  get_graph_content_stream,
} from '@/graph-binary-download';
import { extract_retry_after_ms } from '@/graph-retry-after';
import { classify_download_failure } from '@/graph-download-classification';
import { is_content_gone_error } from '@/graph-request-error-handler';

/**
 * Issue #674: on an ArrayBuffer or stream request the SDK throws the converted body, and its error
 * handler then builds a GraphError without the response headers, so Retry-After never reached
 * `with_graph_retry`. These run a real Graph client over a stubbed transport, so the error is the
 * one the response handling builds, not a hand-made one.
 */

const URL_PATH = '/users/user-1/messages/msg-1/$value';

function real_client(): Client {
  return Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
}

function serve(...responses: Response[]): void {
  vi.stubGlobal('fetch', queued_graph_fetch(...responses).fetch);
}

async function bytes_error(response: Response): Promise<unknown> {
  serve(response);
  return get_graph_bytes(real_client().api(URL_PATH)).catch((err: unknown) => err);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the SDK binary path this replaces', () => {
  it('drops Retry-After from a throttled ArrayBuffer response', async () => {
    serve(throttled_graph_response('20'));

    const err = await real_client()
      .api(URL_PATH)
      .responseType(ResponseType.ARRAYBUFFER)
      .get()
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ statusCode: 429 });
    expect(extract_retry_after_ms(err)).toBeUndefined();
  });
});

describe('get_graph_bytes', () => {
  it('returns the response bytes unchanged', async () => {
    serve(binary_graph_response(new Uint8Array([1, 2, 3])));

    const bytes = await get_graph_bytes(real_client().api(URL_PATH));

    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
  });

  it('keeps a seconds Retry-After, the status and the code on a 429', async () => {
    const err = await bytes_error(throttled_graph_response('20'));

    expect(err).toMatchObject({ statusCode: 429, code: 'TooManyRequests' });
    expect(extract_retry_after_ms(err)).toBe(20_000);
  });

  it('keeps an HTTP-date Retry-After on a 503', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T07:27:00Z'));
    const err = await bytes_error(
      graph_error_response(503, 'serviceNotAvailable', {
        'Retry-After': 'Wed, 21 Oct 2026 07:27:45 GMT',
      }),
    );

    expect(err).toMatchObject({ statusCode: 503, code: 'serviceNotAvailable' });
    expect(extract_retry_after_ms(err)).toBe(45_000);
  });

  it('keeps the status and code of a 404, which still reads as content gone', async () => {
    const err = await bytes_error(graph_error_response(404, 'ErrorItemNotFound'));

    expect(err).toMatchObject({ statusCode: 404, code: 'ErrorItemNotFound' });
    expect(is_content_gone_error(err)).toBe(true);
  });

  it('keeps the code of a 403, so a missing grant and a refusal classify apart', async () => {
    const denied = await bytes_error(graph_error_response(403, 'accessDenied'));
    const refused = await bytes_error(graph_error_response(403, 'notAllowed'));

    expect(denied).toMatchObject({ statusCode: 403, code: 'accessDenied' });
    expect(classify_download_failure(denied)).toBe('missing_permission');
    expect(classify_download_failure(refused)).toBe('service_refused');
  });

  it('keeps a non-JSON error body as text with no code', async () => {
    const err = await bytes_error(new Response('upstream busy', { status: 502 }));

    expect(err).toMatchObject({ statusCode: 502, code: null, body: 'upstream busy' });
  });
});

describe('get_graph_content_stream', () => {
  let body: Response;

  beforeEach(() => {
    body = binary_graph_response(new Uint8Array([4, 5, 6]));
  });

  it('returns the response body stream itself, unbuffered', async () => {
    const expected = body.body;
    serve(body);

    const stream = await get_graph_content_stream(real_client().api(URL_PATH));

    expect(stream).toBe(expected);
  });

  it('keeps Retry-After on a throttled stream request', async () => {
    serve(throttled_graph_response('20'));

    const err = await get_graph_content_stream(real_client().api(URL_PATH)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ statusCode: 429, code: 'TooManyRequests' });
    expect(extract_retry_after_ms(err)).toBe(20_000);
  });

  it('yields an empty stream for a body-less 204', async () => {
    serve(new Response(null, { status: 204 }));

    const stream = await get_graph_content_stream(real_client().api(URL_PATH));

    expect((await stream.getReader().read()).done).toBe(true);
  });
});

describe('get_graph_binary_response', () => {
  it('returns the response with its headers for the caller to read', async () => {
    serve(new Response('x', { status: 200, headers: { 'Content-Type': 'image/png' } }));

    const response = await get_graph_binary_response(real_client().api(URL_PATH));

    expect(response.headers.get('content-type')).toBe('image/png');
  });
});
