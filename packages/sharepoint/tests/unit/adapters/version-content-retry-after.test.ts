import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, HTTPMessageHandler } from '@microsoft/microsoft-graph-client';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import {
  binary_graph_response,
  queued_graph_fetch,
  throttled_graph_response,
} from '@wisecom/atlas-types/testing/queued-graph-fetch';
import {
  recording_throttle_coordinator,
  type RecordingThrottleCoordinator,
} from '@wisecom/atlas-types/testing/recording-throttle-coordinator';
import {
  as_buffer_iterable,
  open_version_content_stream,
} from '@/adapters/graph-sharepoint-stream-utils';

/**
 * Issue #674: a 429 on a version's `/content` lost its Retry-After inside the Graph SDK, so the
 * retry ran after about 1 s and the pool cooled down for the 30 s default. A real Graph client runs
 * over a stubbed transport.
 */

const BYTES = Buffer.from('version-bytes');

let coordinator: RecordingThrottleCoordinator;
let client: Client;

async function drain(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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

describe('open_version_content_stream Retry-After (issue #674)', () => {
  it('waits the 20 s Graph asked for and streams the version bytes', async () => {
    const rig = queued_graph_fetch(throttled_graph_response('20'), binary_graph_response(BYTES));
    vi.stubGlobal('fetch', rig.fetch);

    const stream = run_with_throttle_coordinator(coordinator, 'sharepoint_onedrive', () =>
      open_version_content_stream(client, 'drive-1', 'item-1', '3.0'),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rig.urls).toHaveLength(1);
    expect(coordinator.raises).toEqual([['sharepoint_onedrive', 20_000]]);
    await vi.advanceTimersByTimeAsync(2_001);

    expect(rig.urls).toHaveLength(2);
    expect(rig.urls[1]).toContain('/drives/drive-1/items/item-1/versions/3.0/content');
    expect(await drain(as_buffer_iterable(await stream))).toEqual(BYTES);
  });
});
