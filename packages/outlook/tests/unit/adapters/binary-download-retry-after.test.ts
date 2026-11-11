import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  binary_graph_response,
  graph_error_response,
  queued_graph_fetch,
  throttled_graph_response,
  type QueuedGraphFetch,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { fetch_message_mime } from '@/adapters/graph-message-mime-fetcher';
import { fetch_attachment_content } from '@/adapters/graph-attachment-content-fetcher';

/**
 * Issue #674: a 429 on a `$value` download lost its Retry-After inside the Graph SDK, so the retry
 * ran after about 1 s and the pool cooled down for the 30 s default. Both Outlook binary paths now
 * honour the value Graph sent. A real Graph client runs over a stubbed transport.
 */

const PREFER = 'IdType="ImmutableId"';
const BYTES = Buffer.from('Received: from mail.example.com\r\n\r\nbody\r\n');

let coordinator: RecordingThrottleCoordinator;
let client: Client;

function serve(...responses: Response[]): QueuedGraphFetch {
  const rig = queued_graph_fetch(...responses);
  vi.stubGlobal('fetch', rig.fetch);
  return rig;
}

function under_coordinator<T>(fn: () => Promise<T>): Promise<T> {
  return run_with_throttle_coordinator(coordinator, 'outlook', fn);
}

/** Runs a download that is throttled once with Retry-After 20 and checks the wait it took. */
async function expect_twenty_second_wait(download: () => Promise<unknown>): Promise<unknown> {
  const rig = serve(throttled_graph_response('20'), binary_graph_response(BYTES));

  const result = under_coordinator(download);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(rig.urls).toHaveLength(1);
  expect(coordinator.raises).toEqual([['outlook', 20_000]]);
  await vi.advanceTimersByTimeAsync(2_001);
  expect(rig.urls).toHaveLength(2);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  coordinator = recording_throttle_coordinator();
  client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetch_message_mime Retry-After (issue #674)', () => {
  it('waits the 20 s Graph asked for and returns the MIME bytes', async () => {
    const mime = await expect_twenty_second_wait(() =>
      fetch_message_mime(client, 'owner-1', 'msg-1', PREFER),
    );

    expect(mime).toEqual(BYTES);
  });

  it('still resolves undefined for a message that is gone', async () => {
    serve(graph_error_response(404, 'ErrorItemNotFound'));

    await expect(fetch_message_mime(client, 'owner-1', 'gone', PREFER)).resolves.toBeUndefined();
  });

  it('still rethrows a 403 rather than downgrading to the JSON payload', async () => {
    serve(graph_error_response(403, 'ErrorAccessDenied'));

    await expect(fetch_message_mime(client, 'owner-1', 'msg-1', PREFER)).rejects.toThrow();
  });
});

describe('fetch_attachment_content Retry-After (issue #674)', () => {
  it('waits the 20 s Graph asked for and returns the attachment bytes', async () => {
    const content = await expect_twenty_second_wait(() =>
      fetch_attachment_content(client, 'owner-1', 'msg-1', 'att-1', PREFER),
    );

    expect(content).toEqual(BYTES);
  });
});
