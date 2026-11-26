import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { GraphUnavailableError } from '@wisecom/atlas-types';
import {
  graph_error_response,
  queued_graph_fetch,
  type QueuedGraphFetch,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  controlled_response_body,
  streamed_graph_response,
  terminated_body_error,
  type ControlledResponseBody,
} from '@wisecom/atlas-types/testing/controlled-response-body';
import type { TeamsHostedContent } from '@wisecom/atlas-types';
import { download_hosted_content } from '@/adapters/graph-teams-thread-fetch';

/**
 * Issue #877: a hosted-content body used to be read after `with_graph_retry` returned, so it had no
 * attempt timeout, no retry, and did not end on Ctrl+C. It is now read inside each attempt. A real
 * Graph client runs over a stubbed transport.
 */

const LOCATOR = { team_id: 'team-1', channel_id: 'channel-1', root_id: 'root-1' };
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
/** `with_graph_retry` sends the first attempt and 12 retries. */
const MAX_ATTEMPTS = 13;
/** The first retry's backoff is 1 s plus up to 1 s of jitter. */
const FIRST_BACKOFF_MAX_MS = 2_000;

let client: Client;

function serve(...responses: Response[]): QueuedGraphFetch {
  const rig = queued_graph_fetch(...responses);
  vi.stubGlobal('fetch', rig.fetch);
  return rig;
}

function image_response(): Response {
  return new Response(IMAGE, { status: 200, headers: { 'Content-Type': 'image/png' } });
}

function download(): Promise<TeamsHostedContent> {
  return download_hosted_content(client, LOCATOR, 'hosted-1');
}

function expect_image(hosted: TeamsHostedContent): void {
  expect([...hosted.bytes]).toEqual([...IMAGE]);
  expect(hosted.content_type).toBe('image/png');
}

/** A body that has already failed the way a socket closed mid-transfer fails it. */
function cut_body(): ControlledResponseBody {
  const body = controlled_response_body();
  body.push(new Uint8Array([0x89]));
  body.fail(terminated_body_error());
  return body;
}

beforeEach(() => {
  vi.useFakeTimers();
  client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('download_hosted_content body read (issue #877)', () => {
  it('abandons a body that stalls past the 60 s attempt timeout and asks again', async () => {
    const stalled = controlled_response_body();
    const rig = serve(streamed_graph_response(stalled, 'image/png'), image_response());

    const hosted = download();
    await vi.advanceTimersByTimeAsync(30_000);
    stalled.push(new Uint8Array([0x89]));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(rig.urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + FIRST_BACKOFF_MAX_MS);

    expect(stalled.cancelled).toBe(true);
    expect(rig.urls).toHaveLength(2);
    expect_image(await hosted);
  });

  it('asks again within the call when the body is cut off mid-stream', async () => {
    const rig = serve(streamed_graph_response(cut_body(), 'image/png'), image_response());

    const hosted = download();
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MAX_MS);

    expect(rig.urls).toHaveLength(2);
    expect_image(await hosted);
  });

  it('fails with GraphUnavailableError only after every attempt was cut off', async () => {
    const cut = Array.from({ length: MAX_ATTEMPTS }, () => streamed_graph_response(cut_body()));
    const rig = serve(...cut);

    const outcome = download().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(await outcome).toBeInstanceOf(GraphUnavailableError);
    expect(rig.urls).toHaveLength(MAX_ATTEMPTS);
  });

  it('ends the body read at once on the first Ctrl+C', async () => {
    const body = controlled_response_body();
    const rig = serve(streamed_graph_response(body, 'image/png'));
    const run = new AbortController();
    const interrupt = new Error('interrupted');

    const outcome = run_with_abort_signal(run.signal, download).catch((err: unknown) => err);
    body.push(new Uint8Array([0x89]));
    await vi.advanceTimersByTimeAsync(5_000);
    run.abort(interrupt);

    expect(await outcome).toBe(interrupt);
    expect(body.cancelled).toBe(true);
    expect(rig.urls).toHaveLength(1);
  });

  it.each([403, 404])(
    'throws a %i on the first request for the caller to mark missing',
    async (status) => {
      const rig = serve(graph_error_response(status, 'ItemNotFound'));

      await expect(download()).rejects.toMatchObject({ statusCode: status });
      expect(rig.urls).toHaveLength(1);
    },
  );
});
