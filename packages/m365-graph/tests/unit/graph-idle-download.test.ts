import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import {
  graph_error_response,
  queued_graph_fetch,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  controlled_response_body,
  streamed_graph_response,
  terminated_body_error,
  unanswered_fetch,
} from '@wisecom/atlas-types/testing/controlled-response-body';
import {
  GRAPH_DOWNLOAD_IDLE_TIMEOUT_MS,
  get_graph_binary_with_idle_timeout,
} from '@/graph-idle-download';
import { is_network_error } from '@/graph-network-error';

/**
 * Issues #877 and #883: the body of a binary download is read inside the attempt, under an idle
 * timeout that resets on every chunk. A real Graph client runs over a stubbed transport.
 */

const URL_PATH = '/users/user-1/messages/msg-1/$value';

let attempt: AbortController;

function download(): Promise<unknown> {
  const client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
  return get_graph_binary_with_idle_timeout(client.api(URL_PATH), attempt.signal).catch(
    (err: unknown) => ({ rejected: err }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  attempt = new AbortController();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('get_graph_binary_with_idle_timeout', () => {
  it('is 60 s, the default per-attempt timeout', () => {
    expect(GRAPH_DOWNLOAD_IDLE_TIMEOUT_MS).toBe(60_000);
  });

  it('returns the bytes and the Content-Type Graph sent', async () => {
    const body = controlled_response_body();
    vi.stubGlobal('fetch', queued_graph_fetch(streamed_graph_response(body, 'image/png')).fetch);

    const result = download();
    body.push(new Uint8Array([1, 2]));
    body.push(new Uint8Array([3]));
    body.close();

    const { bytes, content_type } = (await result) as { bytes: Buffer; content_type: string };
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(content_type).toBe('image/png');
  });

  it('completes a body that keeps arriving for far longer than the idle limit (issue #33)', async () => {
    const body = controlled_response_body();
    vi.stubGlobal('fetch', queued_graph_fetch(streamed_graph_response(body)).fetch);

    const result = download();
    for (let chunk = 0; chunk < 30; chunk++) {
      await vi.advanceTimersByTimeAsync(GRAPH_DOWNLOAD_IDLE_TIMEOUT_MS - 1_000);
      body.push(new Uint8Array([chunk]));
    }
    body.close();

    const { bytes } = (await result) as { bytes: Buffer };
    expect(bytes).toHaveLength(30);
    expect(body.cancelled).toBe(false);
  });

  it('closes a body that stops arriving after 60 s and rejects with a retryable timeout', async () => {
    const body = controlled_response_body();
    vi.stubGlobal('fetch', queued_graph_fetch(streamed_graph_response(body)).fetch);

    const result = download();
    await vi.advanceTimersByTimeAsync(30_000);
    body.push(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(GRAPH_DOWNLOAD_IDLE_TIMEOUT_MS - 1);
    expect(body.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const { rejected } = (await result) as { rejected: unknown };
    expect(rejected).toMatchObject({ code: 'ETIMEDOUT' });
    expect(is_network_error(rejected)).toBe(true);
    expect(body.cancelled).toBe(true);
  });

  it('aborts a request whose headers do not arrive within 60 s', async () => {
    const transport = unanswered_fetch();
    vi.stubGlobal('fetch', transport.fetch);

    const result = download();
    await vi.advanceTimersByTimeAsync(GRAPH_DOWNLOAD_IDLE_TIMEOUT_MS);

    const { rejected } = (await result) as { rejected: unknown };
    expect(rejected).toMatchObject({ code: 'ETIMEDOUT' });
    expect(transport.signals).toHaveLength(1);
    expect(transport.signals[0]?.aborted).toBe(true);
  });

  it('cancels the body at once when the attempt is aborted mid-read', async () => {
    const body = controlled_response_body();
    vi.stubGlobal('fetch', queued_graph_fetch(streamed_graph_response(body)).fetch);
    const cancelled = new Error('The run was cancelled');

    const result = download();
    body.push(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(5_000);
    attempt.abort(cancelled);

    const { rejected } = (await result) as { rejected: unknown };
    expect(rejected).toBe(cancelled);
    expect(body.cancelled).toBe(true);
  });

  it('rejects with the transport error of a body cut off mid-stream', async () => {
    const body = controlled_response_body();
    vi.stubGlobal('fetch', queued_graph_fetch(streamed_graph_response(body)).fetch);

    const result = download();
    body.push(new Uint8Array([1]));
    body.fail(terminated_body_error());

    const { rejected } = (await result) as { rejected: unknown };
    expect(rejected).toBeInstanceOf(TypeError);
    expect(is_network_error(rejected)).toBe(true);
  });

  it('throws a non-2xx as a GraphError with its status and code', async () => {
    vi.stubGlobal(
      'fetch',
      queued_graph_fetch(graph_error_response(404, 'ErrorItemNotFound')).fetch,
    );

    const { rejected } = (await download()) as { rejected: unknown };
    expect(rejected).toMatchObject({ statusCode: 404, code: 'ErrorItemNotFound' });
  });

  it('leaves no timer running after the body ends', async () => {
    const body = controlled_response_body();
    vi.stubGlobal('fetch', queued_graph_fetch(streamed_graph_response(body)).fetch);

    const result = download();
    body.push(new Uint8Array([1]));
    body.close();
    await result;

    expect(vi.getTimerCount()).toBe(0);
  });
});
