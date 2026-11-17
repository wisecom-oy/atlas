import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  graph_error_response,
  queued_graph_fetch,
  throttled_graph_response,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import { download_hosted_content } from '@/adapters/graph-teams-thread-fetch';

/**
 * Issue #674: hosted content now goes through the shared binary download helper. A throttled
 * `$value` keeps waiting the Retry-After Graph sent, and its Content-Type still comes through. A
 * real Graph client runs over a stubbed transport.
 */

const LOCATOR = { team_id: 'team-1', channel_id: 'channel-1', root_id: 'root-1' };
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let coordinator: RecordingThrottleCoordinator;
let client: Client;

beforeEach(() => {
  vi.useFakeTimers();
  coordinator = recording_throttle_coordinator();
  client = Client.initWithMiddleware({ middleware: new HTTPMessageHandler() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('download_hosted_content Retry-After (issue #674)', () => {
  it('waits the 20 s Graph asked for and returns the bytes and Content-Type', async () => {
    const rig = queued_graph_fetch(
      throttled_graph_response('20'),
      new Response(IMAGE, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', rig.fetch);

    const hosted = run_with_throttle_coordinator(coordinator, 'teams', () =>
      download_hosted_content(client, LOCATOR, 'hosted-1'),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rig.urls).toHaveLength(1);
    expect(coordinator.raises).toEqual([['teams', 20_000]]);
    await vi.advanceTimersByTimeAsync(2_001);

    expect(rig.urls).toHaveLength(2);
    const result = await hosted;
    expect([...result.bytes]).toEqual([...IMAGE]);
    expect(result.content_type).toBe('image/png');
  });

  it('keeps a 403 a GraphError with its code for the caller to treat as missing', async () => {
    vi.stubGlobal('fetch', queued_graph_fetch(graph_error_response(403, 'Forbidden')).fetch);

    await expect(download_hosted_content(client, LOCATOR, 'hosted-1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'Forbidden',
    });
  });
});
