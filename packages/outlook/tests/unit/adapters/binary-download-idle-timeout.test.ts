import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import {
  binary_graph_response,
  queued_graph_fetch,
  type QueuedGraphFetch,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  controlled_response_body,
  streamed_graph_response,
  unanswered_fetch,
  type ControlledResponseBody,
} from '@wisecom/atlas-types/testing/controlled-response-body';
import { fetch_message_mime } from '@/adapters/graph-message-mime-fetcher';
import { fetch_attachment_content } from '@/adapters/graph-attachment-content-fetcher';

/**
 * Issue #883: MIME and attachment downloads keep their 30-minute attempt window for large bodies on
 * slow links (issue #33), but a body or a response that stops arriving loses its attempt after the
 * 60 s idle timeout instead of holding it for the full window. A real Graph client runs over a
 * stubbed transport.
 */

const PREFER = 'IdType="ImmutableId"';
const BYTES = Buffer.from('Received: from mail.example.com\r\n\r\nbody\r\n');
const IDLE_MS = 60_000;
const ATTEMPT_MS = 30 * 60_000;
/** The first retry's backoff is 1 s plus up to 1 s of jitter. */
const FIRST_BACKOFF_MAX_MS = 2_000;

let client: Client;

function serve(...responses: Response[]): QueuedGraphFetch {
  const rig = queued_graph_fetch(...responses);
  vi.stubGlobal('fetch', rig.fetch);
  return rig;
}

function mime(): Promise<Buffer> {
  return fetch_message_mime(client, 'owner-1', 'msg-1', PREFER);
}

function attachment(): Promise<Buffer> {
  return fetch_attachment_content(client, 'owner-1', 'msg-1', 'att-1', PREFER);
}

/** Pushes one byte every `gap_ms` for `count` chunks. */
async function trickle(body: ControlledResponseBody, count: number, gap_ms: number): Promise<void> {
  for (let chunk = 0; chunk < count; chunk++) {
    await vi.advanceTimersByTimeAsync(gap_ms);
    body.push(new Uint8Array([0x41]));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([
  ['fetch_message_mime', mime],
  ['fetch_attachment_content', attachment],
])('%s idle timeout (issue #883)', (_name, download) => {
  it('abandons a body that stalls for 60 s and asks again, not after 30 minutes', async () => {
    const stalled = controlled_response_body();
    const rig = serve(streamed_graph_response(stalled), binary_graph_response(BYTES));

    const result = download();
    stalled.push(new Uint8Array([0x52]));
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(rig.urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + FIRST_BACKOFF_MAX_MS);

    expect(stalled.cancelled).toBe(true);
    expect(rig.urls).toHaveLength(2);
    expect(await result).toEqual(BYTES);
  });

  it('abandons a request whose headers never arrive after 60 s and asks again', async () => {
    const silent = unanswered_fetch();
    const rig = queued_graph_fetch(binary_graph_response(BYTES));
    let requests = 0;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      requests++ === 0 ? silent.fetch(input, init) : rig.fetch(input, init),
    );

    const result = download();
    await vi.advanceTimersByTimeAsync(IDLE_MS + FIRST_BACKOFF_MAX_MS);

    expect(silent.signals[0]?.aborted).toBe(true);
    expect(requests).toBe(2);
    expect(await result).toEqual(BYTES);
  });

  it('completes a body that trickles in for 20 minutes in one request (issue #33)', async () => {
    const slow = controlled_response_body();
    const rig = serve(streamed_graph_response(slow));

    const result = download();
    await trickle(slow, 24, 50_000);
    slow.close();

    expect(rig.urls).toHaveLength(1);
    expect(await result).toHaveLength(24);
  });

  it('still ends an attempt that keeps trickling at the 30-minute attempt timeout', async () => {
    const endless = controlled_response_body();
    const rig = serve(streamed_graph_response(endless), binary_graph_response(BYTES));

    const result = download();
    await trickle(endless, ATTEMPT_MS / 50_000, 50_000);
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MAX_MS);

    expect(endless.cancelled).toBe(true);
    expect(rig.urls).toHaveLength(2);
    expect(await result).toEqual(BYTES);
  });
});
