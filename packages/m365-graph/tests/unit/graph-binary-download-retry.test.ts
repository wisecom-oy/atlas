import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { ThrottledError } from '@wisecom/atlas-types';
import {
  binary_graph_response,
  queued_graph_fetch,
  throttled_graph_response,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { get_graph_bytes } from '@/graph-binary-download';
import { with_graph_retry } from '@/graph-request-error-handler';

/**
 * Issue #674: a throttled binary download must reach `with_graph_retry` with its Retry-After, so the
 * retry waits what Graph asked and the pool cooldown is raised for that long, not for the 30 s
 * default after a 1 s backoff.
 */

const URL_PATH = '/users/user-1/messages/msg-1/$value';
/** `with_graph_retry` sends the first attempt and 12 retries. */
const MAX_ATTEMPTS = 13;

let coordinator: RecordingThrottleCoordinator;

function download(): Promise<ArrayBuffer> {
  const client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
  return run_with_throttle_coordinator(coordinator, 'outlook', () =>
    with_graph_retry(() => get_graph_bytes(client.api(URL_PATH))),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  coordinator = recording_throttle_coordinator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('with_graph_retry over a binary download', () => {
  it('waits the 20 s Retry-After and raises a 20 s cooldown', async () => {
    const rig = queued_graph_fetch(
      throttled_graph_response('20'),
      binary_graph_response(new Uint8Array([7, 8])),
    );
    vi.stubGlobal('fetch', rig.fetch);

    const result = download();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rig.urls).toHaveLength(1);
    expect(coordinator.raises).toEqual([['outlook', 20_000]]);

    // The retry lands after the Retry-After plus at most 2 s of release jitter.
    await vi.advanceTimersByTimeAsync(2_001);
    expect(rig.urls).toHaveLength(2);
    expect([...new Uint8Array(await result)]).toEqual([7, 8]);
  });

  it('throws ThrottledError carrying the Retry-After once retries run out', async () => {
    const throttled = Array.from({ length: MAX_ATTEMPTS }, () => throttled_graph_response('20'));
    vi.stubGlobal('fetch', queued_graph_fetch(...throttled).fetch);

    const outcome = download().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(MAX_ATTEMPTS * 22_000);
    const err = await outcome;

    expect(err).toBeInstanceOf(ThrottledError);
    expect((err as ThrottledError).retry_after_ms).toBe(20_000);
  });
});
